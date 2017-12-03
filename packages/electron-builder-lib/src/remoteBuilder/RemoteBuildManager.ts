import { path7za } from "7zip-bin"
import BluebirdPromise from "bluebird-lst"
import { Arch, debug, isEnvTrue, log, warn } from "builder-util"
import { HttpError } from "builder-util-runtime"
import { spawn } from "child_process"
import { UploadTask } from "electron-publish"
import { createWriteStream } from "fs"
import { ensureDir, outputFile } from "fs-extra-p"
import { ClientHttp2Session, ClientHttp2Stream, connect, constants, OutgoingHttpHeaders, SecureClientSessionOptions } from "http2"
import * as path from "path"
import { URL } from "url"
import { Target, TargetSpecificOptions } from "../core"
import { ArtifactCreated } from "../packagerApi"
import { PlatformPackager } from "../platformPackager"
import { JsonStreamParser } from "../util/JsonStreamParser"
import { DevTimer } from "../util/timer"
import { ProjectInfoManager } from "./ProjectInfoManager"
import { ELECTRON_BUILD_SERVICE_CA_CERT, ELECTRON_BUILD_SERVICE_LOCAL_CA_CERT } from "./remote-builder-certs"
import { RemoteBuilderResponse } from "./RemoteBuilder"

const {
  HTTP2_HEADER_PATH,
  HTTP2_METHOD_POST,
  HTTP2_METHOD_GET,
  HTTP2_HEADER_METHOD,
  HTTP2_HEADER_CONTENT_TYPE,
  HTTP2_HEADER_STATUS,
  HTTP_STATUS_OK,
  HTTP_STATUS_BAD_REQUEST
} = constants

export function getConnectOptions(): SecureClientSessionOptions {
  const options: SecureClientSessionOptions = {}
  const caCert = process.env.ELECTRON_BUILD_SERVICE_CA_CERT
  if (caCert !== "false") {
    const isUseLocalCert = isEnvTrue(process.env.USE_ELECTRON_BUILD_SERVICE_LOCAL_CA)
    if (isUseLocalCert) {
      debug("Local certificate authority is used")
    }
    options.ca = caCert || (isUseLocalCert ? ELECTRON_BUILD_SERVICE_LOCAL_CA_CERT : ELECTRON_BUILD_SERVICE_CA_CERT)
    // we cannot issue cert per IP because build agent can be started on demand (and for security reasons certificate authority is offline).
    // Since own certificate authority is used, it is ok to skip server name verification.
    options.checkServerIdentity = () => undefined
  }
  return options
}

export class RemoteBuildManager {
  private readonly client: ClientHttp2Session

  private files: Array<ArtifactInfo> | null = null
  private finishedStreamCount = 0

  constructor(private readonly buildServiceEndpoint: string,
              private readonly projectInfoManager: ProjectInfoManager,
              private readonly unpackedDirectory: string,
              private readonly outDir: string,
              private readonly packager: PlatformPackager<any>) {
    debug(`Connect to remote build service: ${buildServiceEndpoint}`)
    this.client = connect(buildServiceEndpoint, getConnectOptions())
  }

  build(customHeaders: OutgoingHttpHeaders): Promise<RemoteBuilderResponse | null> {
    return new BluebirdPromise<RemoteBuilderResponse | null>((resolve, reject) => {
      const client = this.client
      client.on("socketError", reject)
      client.on("error", reject)

      let handled = false
      client.once("close", () => {
        if (!handled) {
          reject(new Error("Closed unexpectedly"))
        }
      })
      client.once("timeout", () => {
        reject(new Error("Timeout"))
      })

      this.doBuild(customHeaders, result => {
        handled = true
        resolve(result)
      }, reject)
    })
      .finally(() => {
        this.client.destroy()
      })
  }

  private doBuild(customHeaders: OutgoingHttpHeaders, resolve: (result: RemoteBuilderResponse | null) => void, reject: (error: Error) => void): void {
    this.upload(customHeaders, resolve, reject)
  }

  private upload(customHeaders: OutgoingHttpHeaders, resolve: (result: RemoteBuilderResponse | null) => void, reject: (error: Error) => void) {
    const zstdCompressionLevel = getZstdCompressionLevel(this.buildServiceEndpoint)

    const stream = this.client.request({
      [HTTP2_HEADER_PATH]: "/v1/upload",
      [HTTP2_HEADER_METHOD]: HTTP2_METHOD_POST,
      [HTTP2_HEADER_CONTENT_TYPE]: "application/octet-stream",
      ...customHeaders,
      // only for stats purpose, not required for build
      "x-zstd-compression-level": zstdCompressionLevel,
    })
    stream.on("error", reject)
    // this.handleStreamEvent(resolve, reject)
    this.uploadUnpackedAppArchive(stream, zstdCompressionLevel, reject)

    stream.on("response", headers => {
      const status: number = headers[HTTP2_HEADER_STATUS] as any
      if (status !== HTTP_STATUS_OK && status !== HTTP_STATUS_BAD_REQUEST) {
        reject(new HttpError(status))
        return
      }

      let data = ""
      stream.setEncoding("utf8")
      stream.on("data", (chunk: string) => {
        data += chunk
      })
      stream.on("end", () => {
        const result = data.length === 0 ? {} : JSON.parse(data)
        if (debug.enabled) {
          debug(`Remote builder result: ${JSON.stringify(result, null, 2)}`)
        }

        if (status === HTTP_STATUS_BAD_REQUEST) {
          reject(new HttpError(status, JSON.stringify(result, null, 2)))
          return
        }

        const id = result.id
        if (id == null) {
          reject(new Error("Server didn't return id"))
          return
        }

        // cannot connect immediately because channel status is not yet created
        setTimeout(() => {
          this.listenEvents(id)
            .then(resolve)
            .catch(reject)
        }, 2 * 1000)
      })
    })
  }

  private listenEvents(id: string): Promise<RemoteBuilderResponse | null> {
    return new BluebirdPromise((resolve, reject) => {
      const stream = this.client.request({
        [HTTP2_HEADER_PATH]: `/v1/status/${id}`,
        [HTTP2_HEADER_METHOD]: HTTP2_METHOD_GET,
      })
      stream.on("error", reject)
      stream.on("response", headers => {
        if (!checkStatus(headers[HTTP2_HEADER_STATUS] as any, reject)) {
          return
        }

        stream.setEncoding("utf8")
        const eventSource = new JsonStreamParser(data => {
          if (debug.enabled) {
            debug(`Remote builder event: ${JSON.stringify(data, null, 2)}`)
          }

          const error = data.error
          if (error != null) {
            stream.destroy()
            resolve(data)
            return
          }

          if (data.state != null) {
            let message = data.state
            switch (data.state) {
              case "added":
                message = "Job added to build queue."
                break

              case "started":
                message = "Job started."
                break
            }
            log(message)
            return
          }

          if (!("files" in data)) {
            warn(`Unknown builder event: ${JSON.stringify(data)}`)
            return
          }

          // close, no more events are expected
          stream.destroy()

          this.files = data.files
          for (const artifact of this.files!!) {
            log(`Downloading ${artifact.file}`)
            this.downloadFile(id, artifact, resolve, reject)
          }
        })
        stream.on("data", (chunk: string) => eventSource.parseIncoming(chunk))
      })
    })
  }

  private downloadFile(id: string, artifact: ArtifactInfo, resolve: (result: RemoteBuilderResponse | null) => void, reject: (error: Error) => void) {
    const downloadTimer = new DevTimer("compress and upload")
    const stream = this.client.request({
      // use URL to encode path properly (critical for filenames with unicode symbols, e.g. "boo-Test App ßW")
      [HTTP2_HEADER_PATH]: `/v1/download${new URL(`f:/${id}/${artifact.file}`).pathname}`,
      [HTTP2_HEADER_METHOD]: HTTP2_METHOD_GET,
    })
    stream.on("error", reject)

    const localFile = path.join(this.outDir, artifact.file)
    const artifactCreatedEvent = this.artifactInfoToArtifactCreatedEvent(artifact, localFile)
    const fileWritten = () => {
      this.finishedStreamCount++
      log(`${artifact.file} is downloaded in ${downloadTimer.endAndGet()}`)
      if (debug.enabled) {
        debug(`Remote artifact saved to: ${localFile}`)
      }

      // PublishManager uses outDir and options, real (the same as for local build) values must be used
      this.projectInfoManager.packager.dispatchArtifactCreated(artifactCreatedEvent)

      if (this.files != null && this.finishedStreamCount >= this.files.length) {
        resolve(null)
      }
    }

    stream.on("response", headers => {
      if (!checkStatus(headers[HTTP2_HEADER_STATUS] as any, reject)) {
        return
      }

      if (artifact.file.endsWith(".yml") || artifact.file.endsWith(".json")) {
        const buffers: Array<Buffer> = []
        stream.on("end", () => {
          const fileContent = buffers.length === 1 ? buffers[0] : Buffer.concat(buffers)
          artifactCreatedEvent.fileContent = fileContent
          outputFile(localFile, fileContent)
            .then(fileWritten)
            .catch(reject)
        })
        stream.on("data", (chunk: Buffer) => {
          buffers.push(chunk)
        })
      }
      else {
        ensureDir(path.dirname(localFile))
          .then(() => {
            const fileStream = createWriteStream(localFile, {
              // 1MB buffer, download as faster as possible, reduce chance that download will be paused for a while due to slow file write
              highWaterMark: 1024 * 1024,
            } as any)
            fileStream.on("error", reject)
            fileStream.on("close", fileWritten)
            stream.pipe(fileStream)
          })
          .catch(reject)
      }
    })
  }

  private artifactInfoToArtifactCreatedEvent(artifact: ArtifactInfo, localFile: string): ArtifactCreated {
    const target = artifact.target
    // noinspection SpellCheckingInspection
    return {
      ...artifact,
      file: localFile,
      target: target == null ? null : new FakeTarget(target, this.outDir, (this.packager.config as any)[target]),
      packager: this.packager,
    }
  }

  // compress and upload in the same time, directly to remote without intermediate local file
  private uploadUnpackedAppArchive(stream: ClientHttp2Stream, zstdCompressionLevel: string, reject: (error: Error) => void) {
    const packager = this.projectInfoManager.packager
    const buildResourcesDir = packager.buildResourcesDir
    if (buildResourcesDir === packager.projectDir) {
      reject(new Error(`Build resources dir equals to project dir and so, not sent to remote build agent. It will lead to incorrect results.\nPlease set "directories.buildResources" to separate dir or leave default ("build" directory in the project root)`))
      return
    }

    this.projectInfoManager.infoFile.value
      .then(infoFile => {
        log(`Compressing and uploading to remote build agent`)
        const compressAndUploadTimer = new DevTimer("compress and upload")
        // noinspection SpellCheckingInspection
        const tarProcess = spawn(path7za, [
          "a", "dummy", "-ttar", "-so",
          this.unpackedDirectory,
          infoFile,
          buildResourcesDir,
        ], {
          stdio: ["pipe", "pipe", process.stderr],
        })
        tarProcess.stdout.on("error", reject)

        const zstdProcess = spawn("zstd", [`-${zstdCompressionLevel}`, "--long"], {
          stdio: ["pipe", "pipe", process.stderr],
        })
        zstdProcess.on("error", reject)
        tarProcess.stdout.pipe(zstdProcess.stdin)
        zstdProcess.stdout.pipe(stream)

        zstdProcess.stdout.on("end", () => {
          log(`Uploaded in ${compressAndUploadTimer.endAndGet()}`)
        })
      })
      .catch(reject)
  }
}

function getZstdCompressionLevel(endpoint: string): string {
  const result = process.env.ELECTRON_BUILD_SERVICE_ZSTD_COMPRESSION
  if (result != null) {
    return result
  }
  return endpoint.startsWith("https://127.0.0.1:") || endpoint.startsWith("https://localhost:") || endpoint.startsWith("[::1]:") ? "3" : "19"
}

export function checkStatus(status: number, reject: (error: Error) => void) {
  if (status === HTTP_STATUS_OK) {
    return true
  }
  else {
    reject(new HttpError(status))
    return false
  }
}

class FakeTarget extends Target {
  constructor(name: string, readonly outDir: string, readonly options: TargetSpecificOptions | null | undefined) {
    super(name)
  }

  async build(appOutDir: string, arch: Arch) {
    // no build
  }
}

export interface ArtifactInfo extends UploadTask {
  target: string | null

  readonly isWriteUpdateInfo?: boolean
  readonly updateInfo?: any
}