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
            })
        })

        test('throws the server error when presign fails', async () => {
            mockFetchWithRetry.mockResolvedValueOnce({
                ok: false,
                status: 400,
                json: async () => ({ error: 'Unsupported media type' }),
            })

            await expect(uploadAttachment('token-1', makeFile()))
                .rejects.toThrow('Unsupported media type')
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
