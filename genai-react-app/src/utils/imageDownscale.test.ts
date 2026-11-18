import pica from 'pica'
import { downscaleImageForUpload, MAX_IMAGE_UPLOAD_BYTES } from './imageDownscale'

jest.mock('pica', () => {
    const instance = { resize: jest.fn(), toBlob: jest.fn() }
    return { __esModule: true, default: () => instance }
})

const resizer = pica() as unknown as { resize: jest.Mock; toBlob: jest.Mock }

const MB = 1024 * 1024

const makeFile = (name: string, type: string, size: number): File => {
    const file = new File(['x'], name, { type, lastModified: 42 })
    Object.defineProperty(file, 'size', { value: size })
    return file
}

const blobOf = (size: number): Blob => new Blob([new Uint8Array(Math.round(size))], { type: 'image/png' })

let decoded: { width: number; height: number } | null

beforeAll(() => {
    URL.createObjectURL = jest.fn(() => 'blob:mock')
    URL.revokeObjectURL = jest.fn()
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
        configurable: true,
        value: () => (decoded ? Promise.resolve() : Promise.reject(new Error('EncodingError'))),
    })
    Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', {
        configurable: true,
        get: () => decoded?.width ?? 0,
    })
    Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', {
        configurable: true,
        get: () => decoded?.height ?? 0,
    })
})

beforeEach(() => {
    decoded = { width: 8064, height: 6048 }
    resizer.resize.mockReset().mockImplementation(async (_from, to) => to)
    resizer.toBlob.mockReset()
})

describe('downscaleImageForUpload', () => {
    test('leaves an image at or under the limit untouched', async () => {
        const file = makeFile('small.jpg', 'image/jpeg', MAX_IMAGE_UPLOAD_BYTES)
        expect(await downscaleImageForUpload(file)).toBe(file)
        expect(resizer.resize).not.toHaveBeenCalled()
    })

    test('leaves a PDF untouched whatever its size', async () => {
        const file = makeFile('report.pdf', 'application/pdf', 9 * MB)
        expect(await downscaleImageForUpload(file)).toBe(file)
        expect(resizer.resize).not.toHaveBeenCalled()
    })

    test('leaves a file the browser cannot decode for the backend', async () => {
        decoded = null
        const file = makeFile('IMG_0001.HEIC', '', 12 * MB)
        expect(await downscaleImageForUpload(file)).toBe(file)
        expect(resizer.resize).not.toHaveBeenCalled()
    })

    test('turns a large photo into a PNG under the limit, keeping the aspect ratio', async () => {
        resizer.toBlob.mockResolvedValue(blobOf(4 * MB))
        const out = await downscaleImageForUpload(makeFile('IMG_0001.jpg', 'image/jpeg', 24 * MB))

        expect(out.type).toBe('image/png')
        expect(out.name).toBe('IMG_0001.png')
        expect(out.size).toBeLessThanOrEqual(MAX_IMAGE_UPLOAD_BYTES)
        expect(out.lastModified).toBe(42)
        const canvas = resizer.resize.mock.calls[0][1] as HTMLCanvasElement
        expect(canvas.width * canvas.height * 2.5).toBeLessThanOrEqual(MAX_IMAGE_UPLOAD_BYTES * 1.01)
        expect(canvas.width / canvas.height).toBeCloseTo(8064 / 6048, 2)
        expect(resizer.toBlob).toHaveBeenCalledWith(canvas, 'image/png')
    })

    test('shrinks again when the first PNG is still too large', async () => {
        resizer.toBlob.mockResolvedValueOnce(blobOf(8 * MB)).mockResolvedValueOnce(blobOf(4.5 * MB))
        const out = await downscaleImageForUpload(makeFile('big.jpg', 'image/jpeg', 30 * MB))

        expect(out.type).toBe('image/png')
        expect(resizer.resize).toHaveBeenCalledTimes(2)
        const [first, second] = resizer.resize.mock.calls.map(call => call[1] as HTMLCanvasElement)
        expect(second.width).toBeLessThan(first.width)
    })

    test('steps up once when the first PNG lands well under the limit, keeping the larger one', async () => {
        resizer.toBlob.mockResolvedValueOnce(blobOf(2 * MB)).mockResolvedValueOnce(blobOf(4.6 * MB))
        const out = await downscaleImageForUpload(makeFile('IMG_0003.jpg', 'image/jpeg', 20 * MB))

        expect(resizer.resize).toHaveBeenCalledTimes(2)
        const [first, second] = resizer.resize.mock.calls.map(call => call[1] as HTMLCanvasElement)
        expect(second.width).toBeGreaterThan(first.width)
        expect(out.size).toBe(Math.round(4.6 * MB))
    })

    test('keeps the smaller PNG when stepping up overshoots', async () => {
        resizer.toBlob.mockResolvedValueOnce(blobOf(2 * MB)).mockResolvedValueOnce(blobOf(6 * MB))
        const out = await downscaleImageForUpload(makeFile('IMG_0004.jpg', 'image/jpeg', 20 * MB))

        expect(resizer.resize).toHaveBeenCalledTimes(2)
        expect(out.size).toBe(2 * MB)
    })

    test('caps the long edge at 8000 px', async () => {
        decoded = { width: 20000, height: 100 }
        resizer.toBlob.mockResolvedValue(blobOf(1 * MB))
        await downscaleImageForUpload(makeFile('pano.jpg', 'image/jpeg', 6 * MB))

        const canvas = resizer.resize.mock.calls[0][1] as HTMLCanvasElement
        expect(canvas.width).toBeLessThanOrEqual(8000)
    })

    test('names a pasted image without a name', async () => {
        resizer.toBlob.mockResolvedValue(blobOf(1 * MB))
        const out = await downscaleImageForUpload(makeFile('', 'image/png', 6 * MB))
        expect(out.name).toBe('pasted-image.png')
    })
})
