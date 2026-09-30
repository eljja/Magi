export function registrationName(spec: string) {
  return [
    ...spec.replaceAll("\\", "/").matchAll(/(?:^|\/)oh-my-(openmagi|magi|opencode|openagent)(?:@[^/?#]*)?(?=[/?#]|$)/g),
  ].at(-1)?.[1]
}
