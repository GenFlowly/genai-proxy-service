import {
    getInstructions,
    replaceInstructions,
    seedInstructions,
    setInstructionsCustomer,
} from '../../stores/instructionsStore';
import { InstructionResponse } from '../../models/instruction.models';

const version = (number: number) => ({ id: 'I1', version: number, name: 'Name' }) as unknown as InstructionResponse;
const allVersions = [version(3), version(2), version(1)];

describe('instructionsStore list sources', () => {
    beforeEach(() => {
        localStorage.clear();
        setInstructionsCustomer(null);
        setInstructionsCustomer('C1');
    });

    test('/onboard landing after the full list keeps every version', () => {
        replaceInstructions('C1', allVersions);
        seedInstructions('C1', [version(3)]);
        expect(getInstructions()).toHaveLength(3);
    });

    test('the full list landing after /onboard replaces it', () => {
        seedInstructions('C1', [version(3)]);
        expect(getInstructions()).toHaveLength(1);
        replaceInstructions('C1', allVersions);
        expect(getInstructions()).toHaveLength(3);
    });

    test('a different customer starts over', () => {
        replaceInstructions('C1', allVersions);
        seedInstructions('C2', [version(3)]);
        expect(getInstructions()).toHaveLength(1);
    });

    test('logging out starts over', () => {
        replaceInstructions('C1', allVersions);
        setInstructionsCustomer(null);
        setInstructionsCustomer('C1');
        seedInstructions('C1', [version(3)]);
        expect(getInstructions()).toHaveLength(1);
    });
});
