import { uploadAttachment, getAttachmentViewUrl } from './attachmentService'
import { fetchWithRetry } from '../utils/apiUtils'
import { endpoints } from '../config/endpoints'

jest.mock('../utils/apiUtils')

const mockFetchWithRetry = fetchWithRetry as jest.Mock

const makeFile = (name = 'shot.png', type = 'image/png', size = 1234): File => {
    const file = new File(['x'.repeat(10)], name, { type })
    Object.defineProperty(file, 'size', { value: size })
    return file
}

describe('attachmentService', () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    describe('uploadAttachment', () => {
        test('presigns then PUTs the bytes and returns the ref', async () => {
            const presign = {
                attachmentId: 'att-1',
                s3Key: 'customers/CU1/attachments/att-1',
                mediaType: 'image/png',
                uploadUrl: 'https://bucket.s3.amazonaws.com/signed',
            }
            mockFetchWithRetry
                .mockResolvedValueOnce({ ok: true, json: async () => presign })
                .mockResolvedValueOnce({ ok: true })

            const file = makeFile()
            const ref = await uploadAttachment('token-1', file)

            expect(mockFetchWithRetry).toHaveBeenNthCalledWith(1, endpoints.attachments, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: 'Bearer token-1',
                },
                body: JSON.stringify({ fileName: 'shot.png', mediaType: 'image/png', sizeBytes: 1234 }),
            })
            expect(mockFetchWithRetry).toHaveBeenNthCalledWith(2, presign.uploadUrl, {
                method: 'PUT',
                headers: { 'Content-Type': 'image/png' },
                body: file,
            })
            expect(ref).toEqual({
                attachmentId: 'att-1',
                s3Key: 'customers/CU1/attachments/att-1',
                mediaType: 'image/png',
                filename: 'shot.png',
            })
        })

        // Presign + successful PUT; returns the parsed POST body and the PUT init
        const uploadWithPresign = async (file: File, presign: Record<string, string>) => {
            mockFetchWithRetry
                .mockResolvedValueOnce({ ok: true, json: async () => presign })
                .mockResolvedValueOnce({ ok: true })

            const ref = await uploadAttachment('token-1', file)

            expect(mockFetchWithRetry).toHaveBeenCalledTimes(2)
            const [presignUrl, presignInit] = mockFetchWithRetry.mock.calls[0]
            const [putUrl, putInit] = mockFetchWithRetry.mock.calls[1]
            expect(presignUrl).toBe(endpoints.attachments)
            expect(putUrl).toBe(presign.uploadUrl)
            return { ref, presignBody: JSON.parse(presignInit.body), putInit }
        }

        test('declares application/octet-stream when the browser reports no file type', async () => {
            const presign = {
                attachmentId: 'att-2',
                s3Key: 'customers/CU1/attachments/att-2',
                mediaType: 'application/octet-stream',
                uploadUrl: 'https://bucket.s3.amazonaws.com/signed-2',
            }
            // Chrome/Firefox report '' for HEIC and other formats they don't know
            const file = makeFile('IMG_0001.HEIC', '', 3 * 1024 * 1024)
            expect(file.type).toBe('')

            const { ref, presignBody, putInit } = await uploadWithPresign(file, presign)

            expect(presignBody).toEqual({
                fileName: 'IMG_0001.HEIC',
                mediaType: 'application/octet-stream',
                sizeBytes: 3 * 1024 * 1024,
            })
            expect(putInit).toEqual({
                method: 'PUT',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: file,
            })
            expect(ref).toEqual({
                attachmentId: 'att-2',
                s3Key: 'customers/CU1/attachments/att-2',
                mediaType: 'application/octet-stream',
                filename: 'IMG_0001.HEIC',
            })
        })

        test('sends the file it is given as-is: no type allowlist, size cap or transcoding', async () => {
            const fortyMb = 40 * 1024 * 1024
            const presign = {
                attachmentId: 'att-3',
                s3Key: 'customers/CU1/attachments/att-3',
                mediaType: 'image/heic',
                uploadUrl: 'https://bucket.s3.amazonaws.com/signed-3',
            }
            const file = makeFile('IMG_0002.heic', 'image/heic', fortyMb)

            const { ref, presignBody, putInit } = await uploadWithPresign(file, presign)

            expect(presignBody).toEqual({ fileName: 'IMG_0002.heic', mediaType: 'image/heic', sizeBytes: fortyMb })
            expect(putInit.headers).toEqual({ 'Content-Type': 'image/heic' })
            expect(putInit.body).toBe(file)
            expect(ref.mediaType).toBe('image/heic')
        })

        test.each([
            ['parameters stripped', 'image/heic;q=1', 'image/heic'],
            ['malformed type coerced', 'not-a-media-type', 'application/octet-stream'],
        ])('PUTs with the server-normalized media type, not file.type (%s)', async (_label, fileType, normalized) => {
            const presign = {
                attachmentId: 'att-4',
                s3Key: 'customers/CU1/attachments/att-4',
                mediaType: normalized,
                uploadUrl: 'https://bucket.s3.amazonaws.com/signed-4',
            }
            const file = makeFile('photo.heic', fileType)
            expect(file.type).toBe(fileType)

            const { ref, presignBody, putInit } = await uploadWithPresign(file, presign)

            // The client declares what the browser reported; normalization is the server's job
            expect(presignBody.mediaType).toBe(fileType)
            // ...but must PUT with the effective type bound into the presigned signature
            expect(putInit.headers).toEqual({ 'Content-Type': normalized })
            expect(putInit.headers['Content-Type']).not.toBe(file.type)
            expect(ref.mediaType).toBe(normalized)
        })

        test('falls back to a placeholder file name for unnamed (pasted) blobs', async () => {
            const presign = {
                attachmentId: 'att-5',
                s3Key: 'customers/CU1/attachments/att-5',
                mediaType: 'image/png',
                uploadUrl: 'https://bucket.s3.amazonaws.com/signed-5',
            }

            const { presignBody } = await uploadWithPresign(makeFile('', 'image/png', 10), presign)

            expect(presignBody.fileName).toBe('pasted-image')
        })

        test('throws the server error when presign fails', async () => {
            mockFetchWithRetry.mockResolvedValueOnce({
                ok: false,
                status: 400,
                json: async () => ({ error: 'Attachment size must be at least 1 byte' }),
            })

            await expect(uploadAttachment('token-1', makeFile('empty.png', 'image/png', 0)))
                .rejects.toThrow('Attachment size must be at least 1 byte')
        })

        test('throws a generic error when presign fails without a body', async () => {
            mockFetchWithRetry.mockResolvedValueOnce({
                ok: false,
                status: 500,
                json: async () => { throw new Error('not json') },
            })

            await expect(uploadAttachment('token-1', makeFile()))
                .rejects.toThrow('Attachment presign failed: 500')
        })

        test('throws when the S3 upload fails', async () => {
            mockFetchWithRetry
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({ attachmentId: 'a', s3Key: 'k', mediaType: 'image/png', uploadUrl: 'https://s3/u' }),
                })
                .mockResolvedValueOnce({ ok: false, status: 403 })

            await expect(uploadAttachment('token-1', makeFile()))
                .rejects.toThrow('Attachment upload to S3 failed: 403')
        })
    })

    describe('getAttachmentViewUrl', () => {
        test('returns the presigned view URL', async () => {
            mockFetchWithRetry.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ attachmentId: 'att-1', url: 'https://s3/view' }),
            })

            const url = await getAttachmentViewUrl('token-1', 'att-1')

            expect(mockFetchWithRetry).toHaveBeenCalledWith(endpoints.attachmentUrl('att-1'), {
                method: 'GET',
                headers: { Authorization: 'Bearer token-1' },
            })
            expect(url).toBe('https://s3/view')
        })

        test('throws on non-ok response', async () => {
            mockFetchWithRetry.mockResolvedValueOnce({ ok: false, status: 404 })

            await expect(getAttachmentViewUrl('token-1', 'missing'))
                .rejects.toThrow('Get attachment URL failed: 404')
        })
    })
})
