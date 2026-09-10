import { useRef, useState } from 'react';

import type { TtsProviderId } from '../edge_voice_preferences';
import { t, translationTargetLabel } from '../i18n';
import { languageDisplayName, languageOptionsFor } from '../language_options';
import { isTranslationTarget, TRANSLATION_TARGETS } from '../translation_policy';
import type { PlaybackStatus, ThemeName, TranslationTarget } from '../types';
import { voiceOptionsFor } from '../voice_options';
import { PlaybackIcon } from './PlaybackIcon';

export interface SettingsCardProps {
	theme: ThemeName;
	activeVoice: string;
	ttsProvider: TtsProviderId;
	/** Language of the content being read; decides which edge voices are on offer. */
	contentLang: string;
	/** The reader's explicit language choice, or `null` while it follows detection. */
	languageOverride: string | null;
	onLanguageOverrideChange: (language: string | null) => void;
	edgeVoice: string | null;
	speed: number;
	selectionButtonEnabled: boolean;
	wordHighlightEnabled: boolean;
	playbackStatus: PlaybackStatus;
	/** `null` wherever translation cannot run, which hides the control entirely. */
	translationTarget: TranslationTarget | null;
	collapsible?: boolean;
	defaultExpanded?: boolean;
	onVoiceChange: (voice: string) => void;
	onTtsProviderChange: (provider: TtsProviderId) => void;
	onEdgeVoiceChange: (voice: string) => void;
	onSpeedChange: (speed: number) => void;
	onSelectionButtonEnabledChange: (enabled: boolean) => void;
	onWordHighlightEnabledChange: (enabled: boolean) => void;
	onThemeChange: (theme: ThemeName) => void;
	onTranslationTargetChange: (target: TranslationTarget) => void;
}

export function SettingsCard({
	theme,
	activeVoice,
	ttsProvider,
	contentLang,
	languageOverride,
	onLanguageOverrideChange,
	edgeVoice,
	speed,
	selectionButtonEnabled,
	wordHighlightEnabled,
	playbackStatus,
	translationTarget,
	collapsible = false,
	defaultExpanded = true,
	onVoiceChange,
	onTtsProviderChange,
	onEdgeVoiceChange,
	onSpeedChange,
	onSelectionButtonEnabledChange,
	onWordHighlightEnabledChange,
	onThemeChange,
	onTranslationTargetChange,
}: SettingsCardProps) {
	const [expanded, setExpanded] = useState(defaultExpanded);
	const [themeMenuOpen, setThemeMenuOpen] = useState(false);
	const themeSelectorButtonRef = useRef<HTMLButtonElement>(null);
	const speedProgress = ((speed - 0.7) / (1.8 - 0.7)) * 100;
	const activeColor = theme === 'wmp12' ? '#0f74bf' : theme === 'winamp' ? '#8fdf53' : '#008771';
	const inactiveColor = theme === 'wmp12' ? '#101517' : theme === 'winamp' ? '#141414' : 'rgba(255, 255, 255, 0.1)';

	const activeThemeName = theme === 'winamp' ? t('themeWinampName') : theme === 'wmp12' ? t('themeWmp12Name') : t('themeDefaultName');

	// Switching engine or voice mid-read is not supported: the units in flight were planned for
	// whichever engine started the session.
	const isVoiceDisabled = playbackStatus === 'playing' || playbackStatus === 'loading';
	const { usingEdge, options: voiceChoices } = voiceOptionsFor(ttsProvider, contentLang);

	return (
		<section className={`settings-card ${collapsible ? 'collapsible' : ''}`} data-theme={theme}>
			<div
				className={`settings-card-header ${collapsible ? 'clickable' : ''}`}
				onClick={collapsible ? () => setExpanded((prev) => !prev) : undefined}
				role={collapsible ? 'button' : undefined}
				tabIndex={collapsible ? 0 : undefined}
				aria-expanded={collapsible ? expanded : undefined}
				onKeyDown={
					collapsible
						? (e) => {
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault();
									setExpanded((prev) => !prev);
								}
							}
						: undefined
				}
			>
				<h2 className="settings-card-title">
					<PlaybackIcon name="settings" /> {t('voiceConfig')}
				</h2>
				{collapsible && (
					<span className="collapse-arrow" data-expanded={expanded}>
						<PlaybackIcon name="chevron" />
					</span>
				)}
			</div>

			{(!collapsible || expanded) && (
				<div className="settings-card-body">
					<label className="selection-button-setting voice-setting">
						<span className="setting-label">{t('ttsProvider')}</span>
						<select
							className="form-select inline-select"
							aria-label={t('ttsProvider')}
							value={ttsProvider}
							onChange={(e) => onTtsProviderChange(e.target.value as TtsProviderId)}
							disabled={isVoiceDisabled}
						>
							<option value="edge">{t('ttsProviderEdge')}</option>
							<option value="supertonic">{t('ttsProviderSupertonic')}</option>
						</select>
					</label>

					{ttsProvider === 'edge' && <p className="setting-note">{t('ttsProviderEdgeNote')}</p>}

					<label className="selection-button-setting voice-setting">
						<span className="setting-label">{t('contentLanguage')}</span>
						<select
							id="content-language-select"
							className="form-select inline-select"
							aria-label={t('contentLanguage')}
							value={languageOverride ?? 'auto'}
							onChange={(e) => onLanguageOverrideChange(e.target.value === 'auto' ? null : e.target.value)}
							disabled={isVoiceDisabled}
						>
							{/* The automatic option names what it resolved to, so a wrong detection is visible
							    without opening the list. */}
							<option value="auto">{t('contentLanguageAuto').replace('{language}', languageDisplayName(contentLang))}</option>
							{languageOptionsFor(ttsProvider).map((language) => (
								<option key={language.code} value={language.code}>
									{language.name}
								</option>
							))}
						</select>
					</label>

					<label className="selection-button-setting voice-setting">
						<span className="setting-label">{t('selectVoice')}</span>
						<select
							id="voice-select"
							className="form-select inline-select"
							aria-label={t('selectVoice')}
							value={usingEdge ? (edgeVoice ?? '') : activeVoice}
							onChange={(e) => (usingEdge ? onEdgeVoiceChange(e.target.value) : onVoiceChange(e.target.value))}
							disabled={isVoiceDisabled}
						>
							{voiceChoices.map((voice) => (
								<option key={voice.id} value={voice.id}>
									{voice.name}
								</option>
							))}
						</select>
					</label>

					<label className="selection-button-setting speed-setting">
						<span className="setting-label">
							{t('readingSpeed')} <span className="slider-value">{speed.toFixed(2)}x</span>
						</span>
						<input
							type="range"
							className="form-slider inline-slider"
							aria-label={t('readingSpeed')}
							min="0.7"
							max="1.8"
							step="0.05"
							value={speed}
							style={{
								background: `linear-gradient(90deg, ${activeColor} 0%, ${activeColor} ${speedProgress}%, ${inactiveColor} ${speedProgress}%)`,
							}}
							onChange={(e) => onSpeedChange(Number.parseFloat(e.target.value))}
						/>
					</label>

					{translationTarget !== null && (
						<label className="selection-button-setting translation-target-setting">
							<span className="setting-label">{t('translationTargetLabel')}</span>
							<select
								className="form-select inline-select"
								aria-label={t('translationTargetLabel')}
								value={translationTarget}
								onChange={(e) => {
									if (isTranslationTarget(e.target.value)) {
										onTranslationTargetChange(e.target.value);
									}
								}}
							>
								{TRANSLATION_TARGETS.map((option) => (
									<option key={option} value={option}>
										{translationTargetLabel(option)}
									</option>
								))}
							</select>
						</label>
					)}

					<div className="settings-card-divider" />

					<label className="selection-button-setting">
						<span className="setting-label">{t('showSelectionButton')}</span>
						<input
							type="checkbox"
							className="selection-button-toggle"
							checked={selectionButtonEnabled}
							onChange={(e) => onSelectionButtonEnabledChange(e.target.checked)}
						/>
					</label>

					<label className="selection-button-setting">
						<span className="setting-label">{t('showWordHighlight')}</span>
						<input
							type="checkbox"
							className="selection-button-toggle"
							checked={wordHighlightEnabled}
							onChange={(e) => onWordHighlightEnabledChange(e.target.checked)}
						/>
					</label>

					<div
						className="selection-button-setting theme-setting"
						onClick={(e) => {
							if ((e.target as HTMLElement).closest('.theme-dropdown')) {
								return;
							}
							setThemeMenuOpen((open) => !open);
						}}
					>
						<span className="setting-label">{t('selectTheme')}</span>
						<div
							className="theme-selector-container"
							onBlur={(e) => {
								if (!e.currentTarget.contains(e.relatedTarget)) {
									setThemeMenuOpen(false);
								}
							}}
							onKeyDown={(e) => {
								if (e.key === 'Escape') {
									setThemeMenuOpen(false);
									themeSelectorButtonRef.current?.focus();
								}
							}}
						>
							<button
								ref={themeSelectorButtonRef}
								className="theme-selector-btn"
								aria-label={t('selectTheme')}
								aria-controls="theme-options"
								aria-expanded={themeMenuOpen}
								onClick={(e) => {
									e.stopPropagation();
									setThemeMenuOpen((open) => !open);
								}}
							>
								{activeThemeName}
							</button>
							<div id="theme-options" className={`theme-dropdown ${themeMenuOpen ? 'open' : ''}`} hidden={!themeMenuOpen}>
								<button
									className={`theme-opt-btn ${theme === 'default' ? 'active' : ''}`}
									onClick={(e) => {
										e.stopPropagation();
										onThemeChange('default');
										setThemeMenuOpen(false);
									}}
								>
									{t('themeDefault')}
								</button>
								<button
									className={`theme-opt-btn ${theme === 'winamp' ? 'active' : ''}`}
									onClick={(e) => {
										e.stopPropagation();
										onThemeChange('winamp');
										setThemeMenuOpen(false);
									}}
								>
									{t('themeWinamp')}
								</button>
								<button
									className={`theme-opt-btn ${theme === 'wmp12' ? 'active' : ''}`}
									onClick={(e) => {
										e.stopPropagation();
										onThemeChange('wmp12');
										setThemeMenuOpen(false);
									}}
								>
									{t('themeWmp12')}
								</button>
							</div>
						</div>
					</div>

					{/* The dictionary lives on a page of its own; this is the way in from either surface. */}
					<button
						type="button"
						className="dictionary-link"
						onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('src/settings/settings.html') })}
					>
						<PlaybackIcon name="book" />
						<span className="setting-label">{t('pronunciationDictionary')}</span>
					</button>
				</div>
			)}
		</section>
	);
}
