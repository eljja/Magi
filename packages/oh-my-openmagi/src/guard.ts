import path from "node:path"

export function protectControl(tool: string, args: unknown, directory: string, home: string) {
  if (!args || typeof args !== "object") return
  const normalize = (value: string) => value.replaceAll("\\", "/").toLowerCase()
  const privatePath = normalize(path.resolve(home))
  const paths = ["filePath", "file_path", "path"].flatMap((key) =>
    typeof Reflect.get(args, key) === "string" ? [String(Reflect.get(args, key))] : [],
  )
  const patch = Reflect.get(args, "patchText")
  if (typeof patch === "string")
    paths.push(
      ...[...patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)].map((match) => match[1]!),
    )
  if (
    paths.some((file) => {
      const resolved = normalize(path.resolve(directory, file))
      return resolved === privatePath || resolved.startsWith(privatePath + "/")
    })
  )
    throw new Error("Magi's private state and local connection credentials are owned by the runtime.")
  if (["read", "glob", "grep", "magi_status"].includes(tool)) return
  const protectedFile = (file: string) =>
    /(?:^|\/)\.magi\/(?:openmagi\.jsonc|votes(?:-latest)?\.md|council\.md|latest-report\.md|history\/|reports\/|backups\/)/.test(
      normalize(file),
    )
  const command = Reflect.get(args, "command")
  if (
    paths.some(protectedFile) ||
    (typeof command === "string" &&
      (normalize(command).includes(privatePath) ||
        /(?:^|[;&|\n])\s*(?:(?:bunx|npx)\s+)?(?:oh-my-(?:open)?magi|omm)(?:@[^\s]+)?\s+(?:stop|resume|report\s+interval|install|serve)\b/i.test(
          command,
        ) ||
        /(?:^|[;&|\n])\s*bun\s+\S*cli\.(?:ts|js)\s+(?:stop|resume|report\s+interval)\b/i.test(command) ||
        /(?:>|\b(?:rm|del|remove-item|set-content|out-file|tee|mv|move-item)\b).*\.magi[\\/](?:openmagi\.jsonc|votes|council|latest-report|history|reports|backups)/i.test(
          command,
        )))
  )
    throw new Error("Only direct human input can change Magi control/configuration. Generated history is read-only.")
}
