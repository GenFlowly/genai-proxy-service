import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AttachmentPreviewStrip, {
    PendingAttachment,
    ResolvedAttachmentThumbnails,
} from '../../../../../components/widgets/ConversationWidget/RequestWidget/AttachmentPreviewStrip';
import { getAttachmentViewUrl } from '../../../../../services/attachmentService';
import { useAuth } from '../../../../../context/AuthContext';
import '@testing-library/jest-dom';

jest.mock('../../../../../context/AuthContext');
jest.mock('../../../../../services/attachmentService');

const mockUseAuth = useAuth as jest.Mock;
const mockGetAttachmentViewUrl = getAttachmentViewUrl as jest.Mock;

describe('AttachmentPreviewStrip', () => {
    const attachments: PendingAttachment[] = [
        { localId: 'l1', fileName: 'a.png', previewUrl: 'blob:a', status: 'ready',
          ref: { attachmentId: 'att-1', s3Key: 'customers/c/attachments/att-1', mediaType: 'image/png' } },
        { localId: 'l2', fileName: 'b.png', previewUrl: 'blob:b', status: 'uploading' },
    ];

    test('renders nothing when there are no attachments', () => {
        const { container } = render(<AttachmentPreviewStrip attachments={[]} onRemove={jest.fn()} />);
        expect(container.firstChild).toBeNull();
    });

    test('renders a thumbnail per attachment with a spinner while uploading', () => {
        render(<AttachmentPreviewStrip attachments={attachments} onRemove={jest.fn()} />);
        expect(screen.getAllByTestId('attachment-thumbnail')).toHaveLength(2);
        expect(screen.getAllByTestId('attachment-uploading-spinner')).toHaveLength(1);
    });

    test('remove button reports the attachment localId', () => {
        const onRemove = jest.fn();
        render(<AttachmentPreviewStrip attachments={attachments} onRemove={onRemove} />);
        fireEvent.click(screen.getAllByTestId('attachment-remove-button')[0]);
        expect(onRemove).toHaveBeenCalledWith('l1');
    });
});

describe('ResolvedAttachmentThumbnails', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockUseAuth.mockReturnValue({
            isAuthenticated: true,
            getAccessTokenSilently: jest.fn().mockResolvedValue('token-1'),
        });
    });

    const refs = [
        { attachmentId: 'att-1', s3Key: 'customers/c/attachments/att-1', mediaType: 'image/png' },
        { attachmentId: 'att-2', s3Key: 'customers/c/attachments/att-2', mediaType: 'image/jpeg' },
    ];

    test('fetches presigned URLs and renders thumbnails', async () => {
        mockGetAttachmentViewUrl.mockImplementation(async (_t: string, id: string) => `https://s3/view/${id}`);

        render(<ResolvedAttachmentThumbnails attachments={refs} />);

        await waitFor(() => {
            expect(screen.getAllByTestId('resolved-attachment-thumbnail')).toHaveLength(2);
        });
        const imgs = screen.getAllByTestId('resolved-attachment-thumbnail');
        expect(imgs[0]).toHaveAttribute('src', 'https://s3/view/att-1');
    });

    test('skips attachments whose URL fetch fails', async () => {
        mockGetAttachmentViewUrl
            .mockResolvedValueOnce('https://s3/view/att-1')
            .mockRejectedValueOnce(new Error('404'));

        render(<ResolvedAttachmentThumbnails attachments={refs} />);

        await waitFor(() => {
            expect(screen.getAllByTestId('resolved-attachment-thumbnail')).toHaveLength(1);
        });
    });

    test('renders nothing when unauthenticated', () => {
        mockUseAuth.mockReturnValue({ isAuthenticated: false, getAccessTokenSilently: jest.fn() });
        const { container } = render(<ResolvedAttachmentThumbnails attachments={refs} />);
        expect(container.firstChild).toBeNull();
        expect(mockGetAttachmentViewUrl).not.toHaveBeenCalled();
    });

    test('opens the image in a new tab on click', async () => {
        mockGetAttachmentViewUrl.mockResolvedValue('https://s3/view/att-1');
        const openSpy = jest.spyOn(window, 'open').mockImplementation(() => null);

        render(<ResolvedAttachmentThumbnails attachments={[refs[0]]} />);
        await waitFor(() => screen.getByTestId('resolved-attachment-thumbnail'));
        fireEvent.click(screen.getByTestId('resolved-attachment-thumbnail'));

        expect(openSpy).toHaveBeenCalledWith('https://s3/view/att-1', '_blank', 'noopener');
        openSpy.mockRestore();
    });
});
