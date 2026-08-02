import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useAuth0 } from '@auth0/auth0-react';
import { 
    createInstruction, 
    shareInstruction, 
    deleteInstruction 
} from '../../services/instructionService';
import PromptEditor from '../../components/widgets/PromptEditorWidget/PromptEditor';
import PillButton from '../../components/common/PillButton/PillButton';
import { InputTextWithHint } from '../../components/common/InputTextWithHint/InputTextWithHint';
import ShareModal, { VisibilityMode } from '../../components/common/ShareModal/ShareModal';
import { SearchUserResponse } from '../../models/user.models';
import styles from './InstructionDetailPage.module.scss';
import Navbar from '../../components/navbar/Navbar';

export default function InstructionDetailPage() {
    const { instructionId } = useParams<{ instructionId: string }>();
    const navigate = useNavigate();
    const { getAccessTokenSilently } = useAuth0();
    const { customerInstructions, refreshInstructions, updateInstruction } = useAuth();

    const isNew = instructionId === 'new';
    
    const [name, setName] = useState('');
    const [instructionText, setInstructionText] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [isShareModalOpen, setIsShareModalOpen] = useState(false);

    useEffect(() => {
        if (!isNew && instructionId) {
            // Find the latest version of this instruction
            const matching = customerInstructions.filter(i => i.id === instructionId);
            const latest = matching.sort((a, b) => b.version - a.version)[0];
            
            if (latest) {
                setName(latest.name || '');
                setInstructionText(latest.instruction || '');
                // Basic ownership check (if creator field is available on the model, otherwise assume false for safety or true if we rely on backend)
                // Actually the frontend InstructionResponse doesn't have `creator`. 
                // We will rely on backend to throw an error if they try to delete something they don't own.
            }
        }
    }, [instructionId, isNew, customerInstructions]);

    const handleSave = async () => {
        if (!instructionText.trim()) return;
        setIsLoading(true);
        try {
            const token = await getAccessTokenSilently();
            const response = await createInstruction(token, {
                instruction: instructionText,
                instructionName: name || undefined,
                existingInstructionId: isNew ? undefined : instructionId
            });

            if (response.id) {
                updateInstruction(response);
                refreshInstructions();
                if (isNew || response.id !== instructionId) { // Handles branching
                    navigate(`/instructions/${response.id}`, { replace: true });
                }
            }
        } catch (error) {
            console.error("Failed to save instruction", error);
            alert("Failed to save instruction");
        } finally {
            setIsLoading(false);
        }
    };

    const handleShareClick = () => {
        setIsShareModalOpen(true);
    };

    const handleShareSave = async (mode: VisibilityMode, users: SearchUserResponse[]) => {
        if (mode === 'PRIVATE' || mode === 'PUBLIC') {
            alert(`Backend currently doesn't support ${mode} mode. Only SPECIFIC mode works.`);
            return;
        }

        setIsLoading(true);
        try {
            const token = await getAccessTokenSilently();
            for (const user of users) {
                await shareInstruction(token, instructionId!, user.customerId);
            }
            alert(`Instruction shared successfully with ${users.length} users!`);
        } catch (error) {
            console.error("Failed to share instruction", error);
            alert("Failed to share instruction. Make sure you own it.");
        } finally {
            setIsLoading(false);
        }
    };

    const handleDelete = async () => {
        if (!window.confirm("Are you sure you want to delete this instruction? This action cannot be undone.")) return;
        
        setIsLoading(true);
        try {
            const token = await getAccessTokenSilently();
            await deleteInstruction(token, instructionId!);
            refreshInstructions();
            navigate('/instructions');
        } catch (error) {
            console.error("Failed to delete instruction", error);
            alert("Failed to delete instruction. You can only delete instructions you own.");
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className={styles.page}>
            <Navbar />
            <div className={styles.pageContainer}>
                <div className={styles.header}>
                <div className={styles.titleGroup}>
                    <button className={styles.backButton} onClick={() => navigate('/instructions')}>
                        &larr; Back
                    </button>
                    <h2>{isNew ? 'Create Instruction' : 'Edit Instruction'}</h2>
                </div>
                
                <div className={styles.actions}>
                    {!isNew && (
                        <>
                            <PillButton 
                                label="Share" 
                                variant="secondary" 
                                onClick={handleShareClick} 
                                disabled={isLoading}
                            />
                            <PillButton 
                                label="Delete" 
                                variant="danger" 
                                onClick={handleDelete} 
                                disabled={isLoading}
                            />
                        </>
                    )}
                    <PillButton 
                        label={isLoading ? 'Saving...' : 'Save'} 
                        variant="primary" 
                        onClick={handleSave} 
                        disabled={isLoading || !instructionText.trim()}
                    />
                </div>
            </div>

            <div className={styles.content}>
                <div className={styles.inputGroup}>
                    <InputTextWithHint
                        hint="Name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="e.g., Code Reviewer Persona"
                    />
                </div>
                
                <div className={styles.editorContainer}>
                    <label className={styles.editorLabel}>Instruction Prompt</label>
                    <PromptEditor
                        id="instruction-detail-editor"
                        value={instructionText}
                        onChange={setInstructionText}
                        disableCache={true}
                        height="100%"
                    />
                </div>
            </div>

            <ShareModal
                isOpen={isShareModalOpen}
                onClose={() => setIsShareModalOpen(false)}
                onSave={handleShareSave}
            />
        </div>
        </div>
    );
}
