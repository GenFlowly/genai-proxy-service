import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import Request from '../../../../../components/widgets/ConversationWidget/RequestWidget/Request';
import { useConversation, useConversationUI } from '../../../../../context/ConversationContext';
import { useAuth } from '../../../../../context/AuthContext';
import { uploadAttachment } from '../../../../../services/attachmentService';
import '@testing-library/jest-dom';

// Mock contexts
const mockShowToast = jest.fn();
jest.mock('../../../../../context/ConversationContext');
jest.mock('../../../../../context/AuthContext');
jest.mock('../../../../../context/ToastContext', () => ({
    useToast: () => ({ showToast: mockShowToast })
}));
jest.mock('../../../../../services/attachmentService');

// Mock child components
jest.mock('@genflowly/component-library', () => ({
    ...jest.requireActual('@genflowly/component-library'),
    TextEditor: ({
        value,
        onChange,
        'data-testid': testId
    }: any) => (
        <textarea
            data-testid={testId}
            value={value}
            onChange={(e) => onChange(e.target.value)}
        />
    ),
    TextContainer: ({ content, title }: { content: string; title?: React.ReactNode }) => (
        <div data-testid="text-container">{title}{content}</div>
    ),
}));

jest.mock('../../../../../components/common/BrandName/BrandName', () => ({
    UserBrandName: ({ name, picture }: any) => (
        <span data-testid="user-brand-name" data-picture={picture ?? ''}>{name}</span>
    )
}));

describe('Request Widget Component', () => {
    const mockUseConversation = useConversation as jest.Mock;
    const mockUseConversationUI = useConversationUI as jest.Mock;
    const mockUseAuth = useAuth as jest.Mock;
    const mockGenerateResponsesStream = jest.fn();
    const mockStopGenerating = jest.fn();
    const mockSetEditorPrompt = jest.fn();
    const mockSetActiveBlockId = jest.fn();
    const mockGetSelectedResponseForBlock = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        // setEditorPrompt moved to the ConversationUI context (perf split);
        // the main-context mocks below may still carry it harmlessly
        mockUseConversationUI.mockReturnValue({ setEditorPrompt: mockSetEditorPrompt });
        mockUseConversation.mockReturnValue({
            conversationBlockList: [{
                conversationBlockId: 'block-1',
                responseMessages: [],
                isLoading: false,
                status: 'draft',
                prompt: ''
            }],
            generateResponsesStream: mockGenerateResponsesStream,
            stopGenerating: mockStopGenerating,
            getSelectedResponseForBlock: mockGetSelectedResponseForBlock,
            setEditorPrompt: mockSetEditorPrompt,
            setActiveBlockId: mockSetActiveBlockId
        });

        mockUseAuth.mockReturnValue({
            aiVendorAPIKeyStatusList: [{ isAPIKeyValid: true }],
            customerName: 'Test User',
            user: { name: 'Auth0 User' },
            customerId: 'cust-123',
            getAccessTokenSilently: jest.fn().mockResolvedValue('test-token')
        });
    });

    test('renders in Editor mode when no responses', () => {
        render(<Request blockId="block-1" data-testid="request-comp" />);
        expect(screen.getByTestId('request-comp')).toBeInTheDocument();
        expect(screen.getByTestId('text-editor')).toBeInTheDocument();
        expect(screen.getByTestId('generate-button')).toBeInTheDocument();
    });

    test('renders in Reader mode when has responses and not loading', () => {
        mockUseConversation.mockReturnValue({
            conversationBlockList: [{
                conversationBlockId: 'block-1',
                responseMessages: [{ id: 'res-1' }],
                isLoading: false,
                status: 'resolved',
                prompt: 'Resolved Prompt'
            }],
            generateResponsesStream: mockGenerateResponsesStream,
            stopGenerating: mockStopGenerating,
            getSelectedResponseForBlock: mockGetSelectedResponseForBlock,
            setEditorPrompt: mockSetEditorPrompt,
            setActiveBlockId: mockSetActiveBlockId
        });

        render(<Request blockId="block-1" data-testid="request-comp" />);
        expect(screen.getByTestId('request-comp')).toBeInTheDocument();
        // Should show resolved content
        expect(screen.getByTestId('text-container')).toHaveTextContent('Resolved Prompt');
        // Editor and button should NOT be there
        expect(screen.queryByTestId('text-editor')).not.toBeInTheDocument();
    });

    test('handles focus and typing (Active state)', () => {
        // use fake timers for debounce
        jest.useFakeTimers();

        render(<Request blockId="block-1" />);
        const editor = screen.getByTestId('text-editor');

        // Test Focus (implicit by typing)
        editor.focus();
        expect(editor).toHaveFocus();

        // Typing updates local state and calls context update (after debounce)
        fireEvent.change(editor, { target: { value: 'New Prompt' } });
        expect(editor).toHaveValue('New Prompt'); // Local state update

        // Check context update
        act(() => {
            jest.advanceTimersByTime(500); // Debounce time
        });

        expect(mockSetActiveBlockId).toHaveBeenCalledWith('block-1');
        expect(mockSetEditorPrompt).toHaveBeenCalledWith('New Prompt');

        jest.useRealTimers();
    });

    test('handles Clicked state (Generate button)', () => {
        mockUseConversation.mockReturnValue({
            conversationBlockList: [{
                conversationBlockId: 'block-1',
                responseMessages: [],
                isLoading: false,
                status: 'draft',
                prompt: 'Ready Prompt'
            }],
            generateResponsesStream: mockGenerateResponsesStream,
            stopGenerating: mockStopGenerating,
            getSelectedResponseForBlock: mockGetSelectedResponseForBlock,
            setEditorPrompt: mockSetEditorPrompt,
            setActiveBlockId: mockSetActiveBlockId
        });
        mockGetSelectedResponseForBlock.mockReturnValue('selected-res-id');

        render(<Request blockId="block-1" />);
        const btn = screen.getByTestId('generate-button');

        fireEvent.click(btn);

        expect(mockGenerateResponsesStream).toHaveBeenCalledWith('block-1', 'Ready Prompt', 'selected-res-id', undefined, []);
    });

    test('renders as TextContainer without any button when loading', () => {
        mockUseConversation.mockReturnValue({
            conversationBlockList: [{
                conversationBlockId: 'block-1',
                responseMessages: [],
                isLoading: true,
                status: 'draft',
                prompt: 'Streaming Prompt'
            }],
            generateResponsesStream: mockGenerateResponsesStream,
            stopGenerating: mockStopGenerating,
            getSelectedResponseForBlock: mockGetSelectedResponseForBlock,
            setEditorPrompt: mockSetEditorPrompt,
            setActiveBlockId: mockSetActiveBlockId
        });

        render(<Request blockId="block-1" />);
        // Editor should NOT be visible, TextContainer should be visible
        expect(screen.queryByTestId('text-editor')).not.toBeInTheDocument();
        expect(screen.getByTestId('resolved-request-wrapper')).toBeInTheDocument();

        // No Stop Generating (or any) button in the Request widget while
        // loading — stopping is handled per-vendor in the Response widget
        expect(screen.queryByTestId('generate-button')).not.toBeInTheDocument();
    });

    test('disable Generate button if API key invalid', () => {
        mockUseAuth.mockReturnValue({
            aiVendorAPIKeyStatusList: [{ isAPIKeyValid: false }],
            customerName: 'Test User'
        });

        render(<Request blockId="block-1" />);
        const btn = screen.getByTestId('generate-button');

        expect(btn).toBeDisabled();

        fireEvent.click(btn);
        expect(mockGenerateResponsesStream).not.toHaveBeenCalled();
    });

    test('sets Active Block on mount if empty', () => {
        render(<Request blockId="block-1" />);
        expect(mockSetActiveBlockId).toHaveBeenCalledWith('block-1');
    });

    test('loads draft from localStorage on mount', () => {
        const storageKey = 'cust-123_prompt_editor_content_conv-block-1';
        localStorage.setItem(storageKey, 'Restored Draft');

        render(<Request blockId="block-1" />);
        const editor = screen.getByTestId('text-editor');

        expect(editor).toHaveValue('Restored Draft');

        // Clean up
        localStorage.removeItem(storageKey);
    });

    describe('message author identity', () => {
        const mockResolvedBlock = (block: Record<string, unknown>) => {
            mockUseConversation.mockReturnValue({
                conversationBlockList: [{
                    conversationBlockId: 'block-1',
                    responseMessages: [{ id: 'res-1' }],
                    isLoading: false,
                    status: 'resolved',
                    prompt: 'Hello',
                    ...block
                }],
                generateResponsesStream: mockGenerateResponsesStream,
                stopGenerating: mockStopGenerating,
                getSelectedResponseForBlock: mockGetSelectedResponseForBlock,
                setEditorPrompt: mockSetEditorPrompt,
                setActiveBlockId: mockSetActiveBlockId
            });
        };

        test('block with a sender shows the sender, not the viewer (shared conversation)', () => {
            mockResolvedBlock({
                sender: { customerId: 'cust-owner', name: 'Owner Name', picture: 'https://pics/owner.png' }
            });

            render(<Request blockId="block-1" />);
            const brand = screen.getByTestId('user-brand-name');
            expect(brand).toHaveTextContent('Owner Name');
            expect(brand).toHaveAttribute('data-picture', 'https://pics/owner.png');
        });

        test('sender without a picture does not fall back to the viewer picture', () => {
            mockUseAuth.mockReturnValue({
                aiVendorAPIKeyStatusList: [{ isAPIKeyValid: true }],
                customerName: 'Test User',
                customerPicture: 'https://pics/viewer.png',
                user: { name: 'Auth0 User' },
                customerId: 'cust-123'
            });
            mockResolvedBlock({ sender: { customerId: 'cust-owner', name: 'Owner Name', picture: null } });

            render(<Request blockId="block-1" />);
            const brand = screen.getByTestId('user-brand-name');
            expect(brand).toHaveTextContent('Owner Name');
            expect(brand).toHaveAttribute('data-picture', '');
        });

        test('block without a sender falls back to the viewer identity (live-sent message)', () => {
            mockResolvedBlock({});

            render(<Request blockId="block-1" />);
            expect(screen.getByTestId('user-brand-name')).toHaveTextContent('Test User');
        });
    });

    describe('keyboard-open scroll behavior', () => {
        let resizeHandler: (() => void) | undefined
        let removeViewportListener: jest.Mock
        let scroller: HTMLDivElement

        // Two blocks so 'block-2' is a follow-up: the keyboard-resize effect
        // only attaches to follow-up editor blocks
        const mockFollowUpBlocks = () => {
            mockUseConversation.mockReturnValue({
                conversationBlockList: [
                    {
                        conversationBlockId: 'block-1',
                        responseMessages: [{ id: 'res-1' }],
                        isLoading: false,
                        status: 'resolved',
                        prompt: 'First prompt'
                    },
                    {
                        conversationBlockId: 'block-2',
                        responseMessages: [],
                        isLoading: false,
                        status: 'draft',
                        prompt: ''
                    }
                ],
                generateResponsesStream: mockGenerateResponsesStream,
                stopGenerating: mockStopGenerating,
                getSelectedResponseForBlock: mockGetSelectedResponseForBlock,
                setEditorPrompt: mockSetEditorPrompt,
                setActiveBlockId: mockSetActiveBlockId
            })
        }

        beforeEach(() => {
            jest.useFakeTimers()
            resizeHandler = undefined
            removeViewportListener = jest.fn()
            Object.defineProperty(window, 'visualViewport', {
                configurable: true,
                value: {
                    height: 800,
                    addEventListener: (event: string, cb: () => void) => {
                        if (event === 'resize') resizeHandler = cb
                    },
                    removeEventListener: removeViewportListener
                }
            })

            // The conversation scroller the effect pins to the end
            scroller = document.createElement('div')
            scroller.setAttribute('data-testid', 'center-section-scroll')
            Object.defineProperty(scroller, 'scrollHeight', { value: 500, configurable: true })
            scroller.scrollTop = 0
            document.body.appendChild(scroller)
        })

        afterEach(() => {
            jest.useRealTimers()
            scroller.remove()
            Object.defineProperty(window, 'visualViewport', {
                configurable: true,
                value: undefined
            })
        })

        const openKeyboard = () => {
            act(() => {
                resizeHandler?.()
                // The effect defers its scroll behind a double rAF; flush both frames
                jest.advanceTimersByTime(100)
            })
        }

        test('pins the conversation to the end when the keyboard opens while the editor is focused', () => {
            mockFollowUpBlocks()
            render(<Request blockId="block-2" />)

            screen.getByTestId('text-editor').focus()
            openKeyboard()

            expect(scroller.scrollTop).toBe(500)
        })

        test('does not scroll when focus is outside the editor', () => {
            mockFollowUpBlocks()
            render(<Request blockId="block-2" />)

            openKeyboard()

            expect(scroller.scrollTop).toBe(0)
        })

        test('does not attach the keyboard-resize listener for the first block', () => {
            render(<Request blockId="block-1" />)

            screen.getByTestId('text-editor').focus()

            expect(resizeHandler).toBeUndefined()
        })

        test('removes the resize listener on unmount', () => {
            mockFollowUpBlocks()
            const { unmount } = render(<Request blockId="block-2" />)
            expect(resizeHandler).toBeDefined()

            unmount()

            expect(removeViewportListener).toHaveBeenCalledWith('resize', resizeHandler)
        })
    })

    describe('image paste-to-upload', () => {
        const mockUploadAttachment = uploadAttachment as jest.Mock;

        const makeImageFile = (type = 'image/png', size = 1024): File => {
            const file = new File(['x'], 'shot.png', { type });
            Object.defineProperty(file, 'size', { value: size });
            return file;
        };

        const pasteImage = (target: HTMLElement, file: File) => {
            fireEvent.paste(target, {
                clipboardData: {
                    items: [{ kind: 'file', type: file.type, getAsFile: () => file }],
                },
            });
        };

        beforeEach(() => {
            (global.URL.createObjectURL as any) = jest.fn(() => 'blob:preview');
            (global.URL.revokeObjectURL as any) = jest.fn();
        });

        test('pasting an image uploads it and shows a ready thumbnail', async () => {
            const ref = { attachmentId: 'att-1', s3Key: 'customers/cust-123/attachments/att-1', mediaType: 'image/png' };
            mockUploadAttachment.mockResolvedValue(ref);

            render(<Request blockId="block-1" />);
            pasteImage(screen.getByTestId('request-widget-container'), makeImageFile());

            expect(await screen.findByTestId('attachment-thumbnail')).toBeInTheDocument();
            await waitFor(() => {
                expect(screen.queryByTestId('attachment-uploading-spinner')).not.toBeInTheDocument();
            });
            expect(mockUploadAttachment).toHaveBeenCalledWith('test-token', expect.any(File));

            // Generate passes the uploaded refs
            fireEvent.click(screen.getByTestId('generate-button'));
            expect(mockGenerateResponsesStream).toHaveBeenCalledWith('block-1', '', undefined, undefined, [ref]);
        });

        test('rejects unsupported media types with a toast', () => {
            render(<Request blockId="block-1" />);
            pasteImage(screen.getByTestId('request-widget-container'), makeImageFile('image/tiff'));

            expect(mockShowToast).toHaveBeenCalled();
            expect(screen.queryByTestId('attachment-thumbnail')).not.toBeInTheDocument();
            expect(mockUploadAttachment).not.toHaveBeenCalled();
        });

        test('rejects oversized images with a toast', () => {
            render(<Request blockId="block-1" />);
            pasteImage(screen.getByTestId('request-widget-container'), makeImageFile('image/png', 6 * 1024 * 1024));

            expect(mockShowToast).toHaveBeenCalled();
            expect(mockUploadAttachment).not.toHaveBeenCalled();
        });

        test('remove button discards the attachment before send', async () => {
            mockUploadAttachment.mockResolvedValue({ attachmentId: 'att-1', s3Key: 'k', mediaType: 'image/png' });

            render(<Request blockId="block-1" />);
            pasteImage(screen.getByTestId('request-widget-container'), makeImageFile());
            await screen.findByTestId('attachment-thumbnail');

            fireEvent.click(screen.getByTestId('attachment-remove-button'));
            expect(screen.queryByTestId('attachment-thumbnail')).not.toBeInTheDocument();

            fireEvent.click(screen.getByTestId('generate-button'));
            expect(mockGenerateResponsesStream).toHaveBeenCalledWith('block-1', '', undefined, undefined, []);
        });

        test('failed uploads show a toast and drop the pending attachment', async () => {
            mockUploadAttachment.mockRejectedValue(new Error('network'));

            render(<Request blockId="block-1" />);
            pasteImage(screen.getByTestId('request-widget-container'), makeImageFile());

            await waitFor(() => {
                expect(mockShowToast).toHaveBeenCalled();
            });
            expect(screen.queryByTestId('attachment-thumbnail')).not.toBeInTheDocument();
        });

        test('blocks Generate while an upload is in flight', async () => {
            let resolveUpload: (v: any) => void = () => {};
            mockUploadAttachment.mockReturnValue(new Promise(r => { resolveUpload = r; }));

            render(<Request blockId="block-1" />);
            pasteImage(screen.getByTestId('request-widget-container'), makeImageFile());
            await screen.findByTestId('attachment-uploading-spinner');

            fireEvent.click(screen.getByTestId('generate-button'));
            expect(mockGenerateResponsesStream).not.toHaveBeenCalled();
            expect(mockShowToast).toHaveBeenCalled();

            await act(async () => {
                resolveUpload({ attachmentId: 'att-1', s3Key: 'k', mediaType: 'image/png' });
            });
        });
    });

    describe('mobile image-attachment button', () => {
        const mockUploadAttachment = uploadAttachment as jest.Mock;
        const originalInnerWidth = window.innerWidth;

        const makeImageFile = (type = 'image/png', size = 1024): File => {
            const file = new File(['x'], 'photo.png', { type });
            Object.defineProperty(file, 'size', { value: size });
            return file;
        };

        const setViewportWidth = (width: number) => {
            Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
            act(() => { window.dispatchEvent(new Event('resize')); });
        };

        beforeEach(() => {
            (global.URL.createObjectURL as any) = jest.fn(() => 'blob:preview');
            (global.URL.revokeObjectURL as any) = jest.fn();
        });

        afterEach(() => {
            Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
        });

        test('renders on mobile only', () => {
            render(<Request blockId="block-1" />);
            expect(screen.queryByTestId('attachment-button')).not.toBeInTheDocument();

            setViewportWidth(500);
            expect(screen.getByTestId('attachment-button')).toBeInTheDocument();
        });

        test('selecting a file uploads it through the shared pipeline', async () => {
            const ref = { attachmentId: 'att-9', s3Key: 'customers/cust-123/attachments/att-9', mediaType: 'image/png' };
            mockUploadAttachment.mockResolvedValue(ref);

            render(<Request blockId="block-1" />);
            setViewportWidth(500);

            const input = screen.getByTestId('attachment-file-input') as HTMLInputElement;
            fireEvent.change(input, { target: { files: [makeImageFile()] } });

            expect(await screen.findByTestId('attachment-thumbnail')).toBeInTheDocument();
            await waitFor(() => {
                expect(screen.queryByTestId('attachment-uploading-spinner')).not.toBeInTheDocument();
            });
            expect(mockUploadAttachment).toHaveBeenCalledWith('test-token', expect.any(File));

            fireEvent.click(screen.getByTestId('generate-button'));
            expect(mockGenerateResponsesStream).toHaveBeenCalledWith('block-1', '', undefined, undefined, [ref]);
        });

        test('rejects unsupported file types with a toast', () => {
            render(<Request blockId="block-1" />);
            setViewportWidth(500);

            const input = screen.getByTestId('attachment-file-input') as HTMLInputElement;
            fireEvent.change(input, { target: { files: [makeImageFile('image/tiff')] } });

            expect(mockShowToast).toHaveBeenCalled();
            expect(mockUploadAttachment).not.toHaveBeenCalled();
        });
    });
});
