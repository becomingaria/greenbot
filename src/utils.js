export function normalizeId(value) {
    if (!value) return null
    return String(value).replace(/[^0-9]/g, "")
}

export function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}
