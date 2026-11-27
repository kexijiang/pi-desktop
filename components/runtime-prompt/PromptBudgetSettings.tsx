"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  createDefaultPromptBudgetConfig,
  PROMPT_BUDGET_LIMITS,
  type PromptBudgetConfig,
} from "@/lib/prompt-runtime/budget";
import styles from "../RuntimePromptSettings.module.css";

type NumericKey = keyof typeof PROMPT_BUDGET_LIMITS;
const NUMERIC_KEYS = Object.keys(PROMPT_BUDGET_LIMITS) as NumericKey[];

function BudgetNumberField({ field, value, disabled, onCommit }: {
  field: NumericKey;
  value: number;
  disabled: boolean;
  onCommit: (value: number) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const { min, max } = PROMPT_BUDGET_LIMITS[field];
  const parsed = draft.trim() === "" ? NaN : Number(draft);
  const valid = Number.isInteger(parsed) && parsed >= min && parsed <= max;
  const label = t(`runtimePrompt.budget.${field}`);
  return (
    <label className={styles.budgetField}>
      <span>{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={draft}
        disabled={disabled}
        aria-label={label}
        aria-invalid={!valid}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (valid && parsed !== value) onCommit(parsed);
          else setDraft(String(value));
        }}
      />
    </label>
  );
}

export function PromptBudgetSettings({ budget, busy, onPatch }: {
  budget: PromptBudgetConfig;
  busy: boolean;
  onPatch: (patch: { budget: Partial<PromptBudgetConfig> }) => void;
}) {
  const { t } = useI18n();
  return (
    <div className={styles.budgetGroup} data-settings-id="conversation.promptBudget">
      <div className={styles.groupLabel}>{t("runtimePrompt.budget.title")}</div>
      <p className={styles.budgetDescription}>{t("runtimePrompt.budget.description")}</p>
      <label className={styles.budgetToggle}>
        <input
          type="checkbox"
          checked={budget.enabled}
          disabled={busy}
          onChange={(event) => onPatch({ budget: { enabled: event.target.checked } })}
        />
        <span>{t("runtimePrompt.budget.enabled")}</span>
      </label>
      <div className={styles.budgetGrid}>
        {NUMERIC_KEYS.map((key) => (
          <BudgetNumberField
            key={key}
            field={key}
            value={budget[key]}
            disabled={busy || !budget.enabled}
            onCommit={(value) => onPatch({ budget: { [key]: value } })}
          />
        ))}
      </div>
      <button
        type="button"
        className={styles.presetButton}
        disabled={busy}
        onClick={() => onPatch({ budget: createDefaultPromptBudgetConfig() })}
      >
        {t("runtimePrompt.budget.reset")}
      </button>
    </div>
  );
}
