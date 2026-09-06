import { chromium, type Browser, type Page } from "playwright-core";

import type { ClassDojoAdapter, ClassRef, StudentNameFormat } from "./roster.js";
import { diffSkills, type SkillCategory, type SkillRule, type SkillRulesAdapter } from "./skills.js";

const CLASSDOJO_URL = "https://teach.classdojo.com";

export type DoctorResult =
  | { status: "ready"; classCount: number; classes: string[] }
  | { status: "not_ready"; error: string; hint: string };

export type ClassDojoUiState = "ready" | "add_students" | "family_invite" | "welcome_message" | "student_account_consent";

export interface ClassDojoBrowserAdapter extends ClassDojoAdapter, SkillRulesAdapter {
  listClasses(): Promise<ClassRef[]>;
  doctor(): Promise<DoctorResult>;
  getUiState(classId: string): Promise<ClassDojoUiState>;
}

export function parseSkillTile(input: {
  category: SkillCategory;
  label: string | null;
  text: string;
  iconSrc: string | null;
}): SkillRule | null {
  const pointsMatch = input.text.trim().match(/([+-]?\d+)\s*$/);
  const iconMatch = input.iconSrc?.match(/\/(\d+)\.png(?:\?|$)/);
  if (!pointsMatch || !iconMatch) return null;

  const name = (input.label ?? input.text.slice(0, pointsMatch.index)).replace(/^(?:编辑|編輯|Edit)\s*/i, "").trim();
  if (!name) return null;
  return {
    category: input.category,
    name,
    points: Number(pointsMatch[1]),
    iconId: Number(iconMatch[1]),
  };
}

export function parseSkillTiles(
  category: SkillCategory,
  tiles: Array<{ label: string | null; text: string; iconSrc: string | null }>,
): SkillRule[] {
  return tiles.filter((tile) => !isAddSkillTile(tile)).map((tile) => {
    const skill = parseSkillTile({ category, ...tile });
    if (!skill) throw new Error(`Could not parse visible ClassDojo skill: ${tile.label ?? tile.text}.`);
    return skill;
  });
}

function isAddSkillTile(tile: { label: string | null; text: string }): boolean {
  const addSkillPattern = /^(?:Add skill|添加技能|新增技能)(?:\s*[（(][^）)]*[）)])?$/i;
  return addSkillPattern.test(tile.text.trim()) || addSkillPattern.test((tile.label ?? "").trim());
}

export function formatSkillPoints(points: number): string {
  return `${points > 0 ? "+" : ""}${points}`;
}

export class AsyncOperationQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function chooseStudentImportStrategy(studentNameFormat: StudentNameFormat): "individual" | "copy_paste" {
  return studentNameFormat === "seat_number_dot_name" ? "individual" : "copy_paste";
}

export function detectClassDojoUiState(text: string): ClassDojoUiState {
  if (/家长电子邮件或电话|Parent email or phone/i.test(text)) return "family_invite";
  if (/暂且略过|Let students enjoy ClassDojo/i.test(text)) return "student_account_consent";
  if (/撰写欢迎消息|Compose a welcome message/i.test(text)) return "welcome_message";
  if (/按姓名查找或添加学生|Search or add students/i.test(text)) return "add_students";
  return "ready";
}

export function parseRosterText(text: string): string[] {
  const rosterText = text.match(/(?:班级|Class)\n([\s\S]*?)(?:添加学生|Add students)/i)?.[1] ?? text;
  return Array.from(rosterText.matchAll(/(?:^|\n)(\d+)\.([^\n\r]+)/g), (match) => {
    return `${match[1]}.${match[2].trim()}`;
  });
}

export class CdpClassDojoAdapter implements ClassDojoBrowserAdapter {
  private browserPromise: Promise<Browser> | undefined;
  private readonly operations = new AsyncOperationQueue();

  constructor(private readonly cdpUrl = process.env.CLASSDOJO_CDP_URL ?? "http://127.0.0.1:9222") {
    const host = new URL(cdpUrl).hostname;
    if (!["127.0.0.1", "localhost", "::1"].includes(host) && process.env.CLASSDOJO_ALLOW_REMOTE_CDP !== "true") {
      throw new Error("CLASSDOJO_CDP_URL must use a loopback host unless CLASSDOJO_ALLOW_REMOTE_CDP=true.");
    }
  }

  async listClasses(): Promise<ClassRef[]> {
    return this.operations.run(async () => {
      const page = await this.getPage();
      await page.goto(`${CLASSDOJO_URL}/#/classes`, { waitUntil: "domcontentloaded" });

      const classes = await page.locator("a").evaluateAll((links) =>
        links
          .map((link) => ({
            classId: link.getAttribute("href")?.match(/\/classes\/([^/?#]+)/)?.[1],
            className: (link.textContent ?? "").trim(),
          }))
          .filter(
            (entry): entry is { classId: string; className: string } =>
              Boolean(entry.classId) && /^\d{3}$/.test(entry.className),
          ),
      );

      return Array.from(new Map(classes.map((classroom) => [classroom.classId, classroom])).values());
    });
  }

  async getRoster(classId: string): Promise<string[]> {
    return this.operations.run(async () => {
      const page = await this.gotoClass(classId);
      return parseRosterText(await page.locator("body").innerText());
    });
  }

  async getUiState(classId: string): Promise<ClassDojoUiState> {
    return this.operations.run(async () => {
      const page = await this.gotoClass(classId);
      return detectClassDojoUiState(await page.locator("body").innerText());
    });
  }

  async getSkills(classId: string): Promise<SkillRule[]> {
    return this.operations.run(async () => {
      const page = await this.gotoSkillsEditor(classId);
      return this.readSkills(page);
    });
  }

  async replaceSkills(classId: string, expectedSkills: SkillRule[], desiredSkills: SkillRule[]): Promise<void> {
    return this.operations.run(async () => {
      const page = await this.gotoSkillsEditor(classId);
      const currentSkills = await this.readSkills(page);
      if (!diffSkills(expectedSkills, currentSkills).matches) {
        throw new Error("Verification failed: skills changed after the preview.");
      }
      const diff = diffSkills(currentSkills, desiredSkills);

      for (const update of diff.updated) {
        await this.editSkill(page, update.before, update.after);
      }

      const addedNames = new Set(diff.added.map((rule) => rule.name));
      const mustRemoveFirst = diff.removed.filter((rule) => addedNames.has(rule.name));
      const canRemoveLast = diff.removed.filter((rule) => !addedNames.has(rule.name));
      await this.deleteSkills(page, mustRemoveFirst);
      for (const rule of diff.added) {
        await this.addSkill(page, rule);
      }
      await this.deleteSkills(page, canRemoveLast);
    });
  }

  async pasteStudents(input: { classId: string; students: string[]; studentNameFormat: StudentNameFormat }): Promise<void> {
    return this.operations.run(async () => {
      const page = await this.gotoClass(input.classId);
      const singleStudentInput = page.locator("input[data-name='addStudentInput']");
      const singleStudentSave = page.locator("button[data-name='addStudentSaveButton']");
      if (chooseStudentImportStrategy(input.studentNameFormat) === "individual") {
        if ((await singleStudentInput.count()) === 0 || (await singleStudentSave.count()) === 0) {
          const addStudents = page.getByText(/^(Add students|添加学生|新增學生)$/).last();
          if ((await addStudents.count()) === 0) {
            throw new Error("Could not find the ClassDojo add-students control.");
          }
          await addStudents.click();
        }
        await singleStudentInput.waitFor({ state: "visible" });
        const suggestion = page.locator("button[data-name='suggestionAddStudentButton']");
        for (const student of input.students) {
          await singleStudentInput.pressSequentially(student);
          await suggestion.waitFor({ state: "visible" });
          await suggestion.click();
        }
        await singleStudentSave.click();
        return;
      }

      let textArea = page.locator("textarea[data-name='import_modal:textarea']");
      if ((await textArea.count()) === 0) {
        const copyPaste = page.locator("button[data-name='copyPasteStudentsButton']");
        if ((await copyPaste.count()) === 0) {
          const addStudents = page.getByText(/^(Add students|添加学生|新增學生)$/).last();
          if ((await addStudents.count()) === 0) {
            throw new Error("Could not find the ClassDojo add-students control.");
          }
          await addStudents.click();
        }
        await page.locator("button[data-name='copyPasteStudentsButton']").click();
        textArea = page.locator("textarea[data-name='import_modal:textarea']");
      }
      await textArea.waitFor({ state: "visible" });
      await textArea.fill(input.students.join("\n"));

      const importStudents = page.locator("button[data-name='importStudentsListButton']");
      if ((await importStudents.count()) === 0) {
        throw new Error("Could not find the ClassDojo import-list control.");
      }
      await importStudents.click();
      await page.waitForTimeout(500);
    });
  }

  async doctor(): Promise<DoctorResult> {
    try {
      const classes = await this.listClasses();
      if (classes.length === 0) {
        return {
          status: "not_ready",
          error: "No ClassDojo classes are visible in the connected browser.",
          hint: "Sign in to teach.classdojo.com in the Chrome instance exposed through CLASSDOJO_CDP_URL.",
        };
      }
      return { status: "ready", classCount: classes.length, classes: classes.map((item) => item.className) };
    } catch (error) {
      return {
        status: "not_ready",
        error: error instanceof Error ? error.message : String(error),
        hint:
          "Start Chrome with --remote-debugging-port=9222, sign in to teach.classdojo.com, then run classdojo_doctor again.",
      };
    }
  }

  private async getBrowser(): Promise<Browser> {
    this.browserPromise ??= chromium.connectOverCDP(this.cdpUrl);
    return this.browserPromise;
  }

  private async getPage(): Promise<Page> {
    const browser = await this.getBrowser();
    const contexts = browser.contexts();
    const existing = contexts.flatMap((context) => context.pages()).find((page) => page.url().includes("teach.classdojo.com"));
    if (existing) return existing;
    const context = contexts[0];
    if (!context) throw new Error("The connected browser has no usable context.");
    return context.newPage();
  }

  private async gotoClass(classId: string): Promise<Page> {
    const page = await this.getPage();
    await page.goto(`${CLASSDOJO_URL}/#/classes/${classId}/points`, { waitUntil: "domcontentloaded" });
    return page;
  }

  private async gotoSkillsEditor(classId: string): Promise<Page> {
    const page = await this.getPage();
    await page.goto(`${CLASSDOJO_URL}/#/classes/${classId}/points?editClass=behaviors`, { waitUntil: "domcontentloaded" });
    await page.locator("[data-name='skills_editor:skill_type:positive']").waitFor({ state: "visible" });
    return page;
  }

  private async selectSkillCategory(page: Page, category: SkillCategory): Promise<void> {
    const selector = `[data-name='skills_editor:skill_type:${category}']`;
    const control = page.locator(selector);
    if (await control.getAttribute("aria-checked") !== "true") {
      await control.click();
      await page.waitForFunction(
        (target) => document.querySelector(target)?.getAttribute("aria-checked") === "true",
        selector,
      );
    }
  }

  private async readSkills(page: Page): Promise<SkillRule[]> {
    const skills: SkillRule[] = [];
    for (const category of ["positive", "needs_work"] as const) {
      await this.selectSkillCategory(page, category);
      const tiles = await page.locator("button[data-name='behaviorTile']:visible").evaluateAll((elements) =>
        elements.map((element) => ({
          label: element.getAttribute("aria-label"),
          text: (element.textContent ?? "").trim(),
          iconSrc: element.querySelector("img")?.getAttribute("src") ?? null,
        })),
      );
      skills.push(...parseSkillTiles(category, tiles));
    }
    return skills;
  }

  private async findSkillTile(page: Page, name: string) {
    const tiles = page.locator("button[data-name='behaviorTile']:visible");
    for (let index = 0; index < await tiles.count(); index += 1) {
      const tile = tiles.nth(index);
      const label = (await tile.getAttribute("aria-label")) ?? "";
      if (label.replace(/^(?:编辑|編輯|Edit|选择|選擇|Select)\s*/i, "").trim() === name) return tile;
    }
    throw new Error(`Could not find the ClassDojo skill: ${name}.`);
  }

  private async setSkillDialogValues(page: Page, rule: SkillRule): Promise<void> {
    await page.locator("input[data-name='skills_editor:dialog_name']:visible").fill(rule.name);
    const points = page.locator("button[data-name='skills_editor:dialog_points']:visible");
    const pointLabel = formatSkillPoints(rule.points);
    if ((await points.innerText()).trim() !== pointLabel) {
      await points.click();
      await page.getByRole("option", { name: pointLabel, exact: true }).click();
    }
    const icon = page.locator(`[data-name='skills_editor:dialog_icon:${rule.iconId}']:visible`);
    if (await icon.getAttribute("data-state") !== "checked") await icon.click();
  }

  private async editSkill(page: Page, current: SkillRule, desired: SkillRule): Promise<void> {
    await this.selectSkillCategory(page, current.category);
    await (await this.findSkillTile(page, current.name)).click();
    await this.setSkillDialogValues(page, desired);
    await page.locator("button[data-name='skills_editor:dialog_save']:visible").click();
    await page.locator("button[data-name='skills_editor:dialog_save']:visible").waitFor({ state: "hidden" });
  }

  private async addSkill(page: Page, rule: SkillRule): Promise<void> {
    await this.selectSkillCategory(page, rule.category);
    const addTile = page.locator("button[data-name='behaviorTile']:visible:not(:has(img))");
    if (await addTile.count() !== 1) throw new Error("Could not find the ClassDojo add-skill control.");
    await addTile.click();
    await this.setSkillDialogValues(page, rule);
    await page.locator("button[data-name='skills_editor:dialog_save']:visible").click();
    await page.locator("button[data-name='skills_editor:dialog_save']:visible").waitFor({ state: "hidden" });
  }

  private async deleteSkills(page: Page, rules: SkillRule[]): Promise<void> {
    for (const category of ["positive", "needs_work"] as const) {
      const selectedRules = rules.filter((rule) => rule.category === category);
      if (selectedRules.length === 0) continue;

      await this.selectSkillCategory(page, category);
      await page.locator("button[data-name='skills_editor:enter_select_mode']:visible").click();
      for (const rule of selectedRules) {
        const tile = await this.findSkillTile(page, rule.name);
        await tile.locator("xpath=..").locator("[data-name^='skills_editor:select:']").click();
      }
      await page.locator("button[data-name='skills_editor:bulk_delete']:visible").click();
      const confirmDelete = page.locator("button[data-name='skills_editor:bulk_delete_confirm:delete']:visible");
      await confirmDelete.waitFor({ state: "visible" });
      await confirmDelete.click();
      await page.locator("button[data-name='skills_editor:enter_select_mode']:visible").waitFor({ state: "visible" });
    }
  }
}
