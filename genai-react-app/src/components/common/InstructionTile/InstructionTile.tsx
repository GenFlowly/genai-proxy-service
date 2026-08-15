import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import styles from './InstructionTile.module.scss';
import { InstructionResponse } from '../../../models/instruction.models';
import { Icon } from '../Icon/Icon';
import { ICONS } from '../../../constants/icons';

interface InstructionTileProps {
    instruction: InstructionResponse;
}

export const InstructionTile: React.FC<InstructionTileProps> = ({ instruction }) => {
    const navigate = useNavigate();
    const { t } = useTranslation();

    const truncateText = (text: string, maxLength: number) => {
        if (!text) return '';
        if (text.length <= maxLength) return text;
        return text.substring(0, maxLength) + '...';
    };

    const handleClick = () => {
        navigate(`/instructions/${instruction.id}`);
    };

    return (
        <div className={styles.tile} onClick={handleClick} data-testid={`instruction-tile-${instruction.id}`}>
            <div className={styles.header}>
                <Icon src={ICONS.USER_ROLE} size={24} className={styles.icon} />
                <h3 className={styles.title}>{instruction.name || t('common.instructionTile.untitledInstruction')}</h3>
            </div>
            <div className={styles.content}>
                {truncateText(instruction.instruction, 140)}
            </div>
            <div className={styles.footer}>
                <span className={styles.version}>v{instruction.version || 1}</span>
            </div>
        </div>
    );
};
