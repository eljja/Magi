import path from "node:path"
import { mkdir, readdir } from "node:fs/promises"
import { sha256, run, type Evidence } from "./evidence"

export function isolatedEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH || "",
    SystemRoot: process.env.SystemRoot || "",
    COMSPEC: process.env.COMSPEC || "",
    // Keep Windows runtime/module discovery while isolating user state and credentials.
    ...(process.platform === "win32"
      ? Object.fromEntries(
          [
            "SystemDrive",
            "windir",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "CommonProgramFiles",
            "CommonProgramFiles(x86)",
            "PSModulePath",
            "PROCESSOR_ARCHITECTURE",
            "OS",
          ]
            .filter((name) => process.env[name] !== undefined)
            .map((name) => [name, process.env[name]]),
        )
      : {}),
    TEMP: path.join(root, "tmp"),
    TMP: path.join(root, "tmp"),
    TMPDIR: path.join(root, "tmp"),
    BUN_TMPDIR: path.join(root, "tmp"),
    BUN_INSTALL_CACHE_DIR: path.join(root, "cache", "bun"),
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    OPENCODE_TEST_HOME: path.join(root, "home"),
    LOCALAPPDATA: path.join(root, "home", "appdata", "local"),
    APPDATA: path.join(root, "home", "appdata", "roaming"),
    OPENMAGI_HOME: path.join(root, "openmagi"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    OPENCODE_CONFIG_DIR: path.join(root, "config", "opencode"),
    OMO_DISABLE_POSTHOG: "1",
    OMO_DISABLE_PROCESS_CLEANUP: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
  }
}

export async function nativeHost(log: Evidence, root: string, version: string, env: NodeJS.ProcessEnv) {
  await Promise.all(["tmp", "home", "tools"].map((directory) => mkdir(path.join(root, directory), { recursive: true })))
  if (process.env.OPENMAGI_OPENCODE_BIN) {
    const file = path.resolve(process.env.OPENMAGI_OPENCODE_BIN)
    log.event("native-binary", {
      path: file,
      sha256: await sha256(file),
      expectedVersion: version,
      source: "explicit override; server version checked at boot",
    })
    return file
  }
  const tools = path.join(root, "tools")
  await Bun.write(
    path.join(tools, "package.json"),
    JSON.stringify({ private: true, dependencies: { "opencode-ai": version } }),
  )
  await run(log, "native-install", [process.execPath, "install", "--ignore-scripts"], { cwd: tools, env })
  const prefix = "opencode-" + (process.platform === "win32" ? "windows" : process.platform) + "-" + process.arch
  const packages = (await readdir(path.join(tools, "node_modules"))).filter(
    (name) => name === prefix || name === prefix + "-baseline",
  )
  const name = packages.find((name) => name.endsWith("-baseline")) || packages[0]
  if (!name) throw new Error("Installed native OpenCode binary not found for " + prefix)
  const file = path.join(tools, "node_modules", name, "bin", process.platform === "win32" ? "opencode.exe" : "opencode")
  log.event("native-binary", {
    path: file,
    sha256: await sha256(file),
    expectedVersion: version,
    source: "isolated exact-version installation",
  })
  return file
}
