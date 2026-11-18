import pica from 'pica'

/** Images up to this size upload untouched; a larger one becomes a PNG under it. */
export const MAX_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024
/** Anthropic rejects an image with an edge above 8000 px. */
const MAX_EDGE_PX = 8000
/** PNG size of a downscaled photo per pixel, for the first guess at the output size. */
const PNG_BYTES_PER_PIXEL = 2.5
/** Each retry undershoots the measured ratio a little so it lands under the limit. */
const RETRY_MARGIN = 0.95
/** A PNG under this share of the limit is retried larger, for the detail the limit allows. */
const FILL_TARGET = 0.8
const MAX_ATTEMPTS = 5

let resizer: ReturnType<typeof pica> | undefined

/** EXIF orientation is applied: an <img> draws upright, which createImageBitmap doesn't promise everywhere. */
async function decode(file: File): Promise<HTMLImageElement | null> {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.src = url
    try {
        await image.decode()
        return image.naturalWidth > 0 && image.naturalHeight > 0 ? image : null
    } catch {
        return null
    } finally {
        URL.revokeObjectURL(url)
    }
}

function pngName(name: string): string {
    const base = name.replace(/\.[^./]*$/, '') || 'image'
    return `${base}.png`
}

/**
 * A large photo from a good camera (often 10-60 MB) is resized to a PNG of at most
 * MAX_IMAGE_UPLOAD_BYTES, so the retrieval server never has to decode the original on its
 * small VM. Anything this browser can't decode (HEIC outside Safari, camera RAW, PDFs, ...)
 * is returned as-is for the backend to convert, as before.
 */
export async function downscaleImageForUpload(file: File): Promise<File> {
    if (file.size <= MAX_IMAGE_UPLOAD_BYTES || file.type === 'application/pdf') return file

    const image = await decode(file)
    if (!image) return file

    const { naturalWidth: width, naturalHeight: height } = image
    resizer ??= pica()
    const maxScale = Math.min(1, MAX_EDGE_PX / Math.max(width, height))
    let scale = Math.min(maxScale, Math.sqrt(MAX_IMAGE_UPLOAD_BYTES / (width * height * PNG_BYTES_PER_PIXEL)))
    let best: Blob | undefined

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(width * scale))
        canvas.height = Math.max(1, Math.round(height * scale))
        await resizer.resize(image, canvas)
        const blob = await resizer.toBlob(canvas, 'image/png')
        if (blob.size <= MAX_IMAGE_UPLOAD_BYTES) {
            best = blob
            if (scale >= maxScale || blob.size >= MAX_IMAGE_UPLOAD_BYTES * FILL_TARGET) break
        } else if (best) {
            break
        }
        scale = Math.min(maxScale, scale * Math.sqrt(MAX_IMAGE_UPLOAD_BYTES / blob.size) * RETRY_MARGIN)
    }
    if (!best) return file
    return new File([best], pngName(file.name || 'pasted-image'), {
        type: 'image/png',
        lastModified: file.lastModified,
    })
}
