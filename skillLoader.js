import fs from 'fs';
import path from 'path';

/**
 * Loads the content of a skill from .agent/skills
 * @param {string} skillName 
 * @returns {Promise<string>}
 */
export async function loadSkill(skillName) {
    try {
        const skillPath = path.join(process.cwd(), '.agent', 'skills', skillName, 'SKILL.md');
        if (fs.existsSync(skillPath)) {
            const content = fs.readFileSync(skillPath, 'utf8');
            // Simple cleaning of frontmatter if needed, but for prompt we can send full md
            return content;
        }
        console.warn(`Skill ${skillName} not found at ${skillPath}`);
        return '';
    } catch (error) {
        console.error(`Error loading skill ${skillName}:`, error);
        return '';
    }
}
