/** Shared text helpers for adapters. */

export const oneLine = (value: unknown, limit: number): string => {
  let raw: string
  if (typeof value === "string") {
    raw = value
  } else {
    try {
      raw = JSON.stringify(value)
    } catch {
      raw = String(value)
    }
  }
  const collapsed = raw.replace(/\s+/g, " ").trim()
  if (collapsed.length <= limit) return collapsed
  return `${collapsed.slice(0, limit)}...`
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const contentText = (content: unknown): string => {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const parts: Array<string> = []
    for (const item of content) {
      if (typeof item === "string") parts.push(item)
      else if (isRecord(item)) {
        const text = item["text"]
        if (typeof text === "string") parts.push(text)
        else if (isRecord(item["data"]) && typeof item["data"]["text"] === "string") {
          parts.push(item["data"]["text"])
        }
      }
    }
    return parts.join("\n")
  }
  if (isRecord(content)) {
    for (const key of ["text", "output", "content", "body"] as const) {
      const v = content[key]
      if (typeof v === "string") return v
    }
  }
  return ""
}

export const withinWindow = (
  updatedAtMs: number,
  withinMin: number | undefined,
  now: number,
): boolean => {
  if (withinMin === undefined || withinMin <= 0) return true
  return now - updatedAtMs >= 0 && now - updatedAtMs <= withinMin * 60 * 1000
}
