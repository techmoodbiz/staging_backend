import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Loads the content of a skill from .agent/skills
 * @param {string} skillName 
 * @returns {Promise<string>}
 */
export async function loadSkill(skillName) {
    try {
        // Using relative path from __dirname to ensure Vercel NFT traces and includes the files
        const skillPath = path.join(__dirname, 'audit-skills', skillName, 'SKILL.md');

        if (fs.existsSync(skillPath)) {
            const content = fs.readFileSync(skillPath, 'utf8');
            return content;
        }
        console.warn(`Skill ${skillName} not found at ${skillPath}`);
        return '';
    } catch (error) {
        console.error(`Error loading skill ${skillName}:`, error);
        return '';
    }
}
