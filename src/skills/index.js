import { SKILLS_CATALOG, getSkillsForTemplate, buildSkillsPrompt } from "./definitions.js";

export { SKILLS_CATALOG, getSkillsForTemplate, buildSkillsPrompt };

export function listAllSkills() {
  return SKILLS_CATALOG;
}

export function getSkill(id) {
  return SKILLS_CATALOG.find((s) => s.id === id) ?? null;
}

export function getSkillsSummary() {
  const total = SKILLS_CATALOG.length;
  const byCategory = SKILLS_CATALOG.reduce((acc, s) => {
    acc[s.category] = (acc[s.category] ?? 0) + 1;
    return acc;
  }, {});
  return { total, byCategory, skills: SKILLS_CATALOG };
}
