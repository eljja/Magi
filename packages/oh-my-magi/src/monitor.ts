import path from "node:path"
import { pathToFileURL } from "node:url"
import { readMagiState } from "./state"
import { publishReport } from "./reporting"

export async function openMagiMonitor(directory: string, open = true) {
  const file = path.resolve(directory, ".magi", "index.html")
  if (!(await Bun.file(file).exists())) await publishReport(directory, await readMagiState(directory))
  const url = pathToFileURL(file).href
  if (open) {
    const command =
      process.platform === "win32"
        ? ["explorer.exe", file]
        : process.platform === "darwin"
          ? ["open", url]
          : ["xdg-open", url]
    const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
    child.unref()
  }
  return url
}
