import { useEffect, useState, useCallback } from 'react';
import { browserStorage } from '../shared/storage.ts';
import { STORAGE_KEYS } from '../shared/constants.ts';
import { t } from '../shared/i18n.ts';
import type { PronunciationRule } from '../shared/types.ts';

const MAX_RULES = 200;

type LangKey = PronunciationRule['lang'];
const LANG_ORDER: LangKey[] = [undefined, 'en', 'vi', 'zh'];

function langLabel(lang: LangKey): string {
	if (lang === 'en') return t('ruleLanguageEn');
	if (lang === 'vi') return t('ruleLanguageVi');
	if (lang === 'zh') return t('ruleLanguageZh');
	return t('ruleLanguageAll');
}

interface RuleGroup {
	lang: LangKey;
	label: string;
	rules: PronunciationRule[];
}

function groupRules(rules: PronunciationRule[], filter: string): RuleGroup[] {
	const groups: RuleGroup[] = [];
	for (const lang of LANG_ORDER) {
		const key = lang ?? 'all';
		if (filter !== 'all' && filter !== key) continue;
		const matching = rules.filter((r) => (r.lang ?? 'all') === key);
		if (matching.length > 0) {
			groups.push({ lang, label: langLabel(lang), rules: matching });
		}
	}
	return groups;
}

function RuleEditRow({
	rule,
	onSave,
	onCancel,
}: {
	rule: PronunciationRule;
	onSave: (updated: PronunciationRule) => void;
	onCancel: () => void;
}) {
	const [match, setMatch] = useState(rule.match);
	const [replacement, setReplacement] = useState(rule.replacement);
	const [wholeWord, setWholeWord] = useState(rule.wholeWord);
	const [caseSensitive, setCaseSensitive] = useState(rule.caseSensitive);
	const [lang, setLang] = useState<string>(rule.lang ?? 'all');

	const handleSave = () => {
		if (!match.trim()) return;
		onSave({
			...rule,
			match: match.trim(),
			replacement,
			wholeWord,
			caseSensitive,
			lang: lang === 'all' ? undefined : (lang as PronunciationRule['lang']),
		});
	};

	return (
		<div className="rule-edit">
			<label className="rule-edit-field">
				<span>{t('ruleMatch')}</span>
				<input
					type="text"
					aria-label={t('ruleMatch')}
					value={match}
					onChange={(e) => setMatch(e.target.value)}
					autoFocus
				/>
			</label>
			<label className="rule-edit-field">
				<span>{t('ruleSpeaksAs')}</span>
				<input
					type="text"
					aria-label={t('ruleSpeaksAs')}
					value={replacement}
					onChange={(e) => setReplacement(e.target.value)}
				/>
			</label>
			<div className="rule-edit-options">
				<label className="rule-checkbox">
					<input type="checkbox" checked={wholeWord} onChange={(e) => setWholeWord(e.target.checked)} />
					<span>{t('ruleWholeWord')}</span>
				</label>
				<label className="rule-checkbox">
					<input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
					<span>{t('ruleCaseSensitive')}</span>
				</label>
				<label className="rule-lang-select">
					<span>{t('ruleLanguage')}</span>
					<select value={lang} onChange={(e) => setLang(e.target.value)}>
						<option value="all">{t('ruleLanguageAll')}</option>
						<option value="en">{t('ruleLanguageEn')}</option>
						<option value="vi">{t('ruleLanguageVi')}</option>
						<option value="zh">{t('ruleLanguageZh')}</option>
					</select>
				</label>
			</div>
			<div className="rule-edit-actions">
				<button type="button" className="btn-save" onClick={handleSave} disabled={!match.trim()}>
					{t('ruleSaveButton')}
				</button>
				<button type="button" className="btn-cancel" onClick={onCancel}>
					{t('ruleCancelButton')}
				</button>
			</div>
		</div>
	);
}

function RuleRow({
	rule,
	onToggle,
	onEdit,
	onDelete,
}: {
	rule: PronunciationRule;
	onToggle: () => void;
	onEdit: () => void;
	onDelete: () => void;
}) {
	return (
		<div className={`rule-row ${!rule.enabled ? 'rule-disabled' : ''}`}>
			<input
				type="checkbox"
				className="rule-enabled-toggle"
				checked={rule.enabled}
				onChange={onToggle}
				aria-label={rule.enabled ? 'Disable rule' : 'Enable rule'}
			/>
			<div className="rule-content" onClick={onEdit} onKeyDown={(e) => e.key === 'Enter' && onEdit()} tabIndex={0} role="button">
				<span className="rule-match">{rule.match}</span>
				<span className="rule-arrow">→</span>
				<span className="rule-replacement">{rule.replacement || '(empty)'}</span>
				{rule.lang && <span className="rule-lang-badge">{rule.lang.toUpperCase()}</span>}
			</div>
			<button type="button" className="btn-icon" onClick={onEdit} aria-label={t('editRule')} title={t('editRule')}>
				✎
			</button>
			<button type="button" className="btn-icon btn-delete" onClick={onDelete} aria-label={t('deleteRule')} title={t('deleteRule')}>
				🗑
			</button>
		</div>
	);
}

export function SettingsApp() {
	const [rules, setRules] = useState<PronunciationRule[]>([]);
	const [langFilter, setLangFilter] = useState<string>('all');
	const [editingId, setEditingId] = useState<string | null>(null);
	const [loaded, setLoaded] = useState(false);

	// Load and apply theme from storage (same as popup)
	useEffect(() => {
		browserStorage.get(STORAGE_KEYS.THEME).then((result) => {
			const theme = result[STORAGE_KEYS.THEME] as string | undefined;
			if (theme && theme !== 'default') {
				document.documentElement.setAttribute('data-theme', theme);
			}
		});
	}, []);

	const loadRules = useCallback(async () => {
		const result = await browserStorage.get(STORAGE_KEYS.PRONUNCIATION_DICTIONARY);
		setRules((result[STORAGE_KEYS.PRONUNCIATION_DICTIONARY] as PronunciationRule[] | undefined) ?? []);
		setLoaded(true);
	}, []);

	const saveRules = useCallback(async (updated: PronunciationRule[]) => {
		setRules(updated);
		await browserStorage.set({ [STORAGE_KEYS.PRONUNCIATION_DICTIONARY]: updated });
	}, []);

	useEffect(() => {
		void loadRules();
	}, [loadRules]);

	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const prefill = params.get('match');
		if (prefill && loaded) {
			handleAdd(prefill);
			// Clear query param so reload doesn't re-trigger
			window.history.replaceState({}, '', window.location.pathname);
		}
	}, [loaded]);

	const handleAdd = (prefillMatch = '') => {
		if (rules.length >= MAX_RULES) return;
		const newRule: PronunciationRule = {
			id: crypto.randomUUID(),
			match: prefillMatch,
			replacement: '',
			wholeWord: true,
			caseSensitive: true,
			enabled: true,
			createdAt: Date.now(),
		};
		setRules((prev) => [newRule, ...prev]);
		setEditingId(newRule.id);
	};

	const handleSave = (updated: PronunciationRule) => {
		const newRules = rules.map((r) => (r.id === updated.id ? updated : r));
		void saveRules(newRules);
		setEditingId(null);
	};

	const handleCancel = (id: string) => {
		// If rule has empty match (newly added, never saved), remove it
		const rule = rules.find((r) => r.id === id);
		if (rule && !rule.match.trim()) {
			setRules((prev) => prev.filter((r) => r.id !== id));
		}
		setEditingId(null);
	};

	const handleToggle = (id: string) => {
		const newRules = rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r));
		void saveRules(newRules);
	};

	const handleDelete = (id: string) => {
		const newRules = rules.filter((r) => r.id !== id);
		void saveRules(newRules);
		if (editingId === id) setEditingId(null);
	};

	const groups = groupRules(
		[...rules].sort((a, b) => b.createdAt - a.createdAt),
		langFilter,
	);
	const atLimit = rules.length >= MAX_RULES;

	return (
		<div className="settings-page">
			<div className="settings-content">
				<header className="settings-header">
					<h1>{t('pronunciationDictionary')}</h1>
				</header>

				<div className="settings-toolbar">
					<button type="button" className="btn-add" onClick={() => handleAdd()} disabled={atLimit}>
						+ {t('addRule')}
					</button>
					<label className="filter-label">
						<span>{t('ruleLanguage')}:</span>
						<select value={langFilter} onChange={(e) => setLangFilter(e.target.value)}>
							<option value="all">{t('ruleLanguageAll')}</option>
							<option value="en">{t('ruleLanguageEn')}</option>
							<option value="vi">{t('ruleLanguageVi')}</option>
							<option value="zh">{t('ruleLanguageZh')}</option>
						</select>
					</label>
					<span className={`rule-counter ${atLimit ? 'at-limit' : ''}`}>
						{rules.length}/{MAX_RULES}
					</span>
				</div>

				{atLimit && <div className="limit-warning">{t('ruleLimitWarning')}</div>}

				{groups.length === 0 && rules.length === 0 && (
					<div className="empty-state">{t('emptyDictionary')}</div>
				)}

				{groups.map((group) => (
					<section key={group.lang ?? 'all'} className="rule-group">
						<h3 className="group-header">{group.label}</h3>
						{group.rules.map((rule) =>
							editingId === rule.id ? (
								<RuleEditRow
									key={rule.id}
									rule={rule}
									onSave={handleSave}
									onCancel={() => handleCancel(rule.id)}
								/>
							) : (
								<RuleRow
									key={rule.id}
									rule={rule}
									onToggle={() => handleToggle(rule.id)}
									onEdit={() => setEditingId(rule.id)}
									onDelete={() => handleDelete(rule.id)}
								/>
							),
						)}
					</section>
				))}
			</div>
		</div>
	);
}
