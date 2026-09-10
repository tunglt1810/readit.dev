import assert from 'node:assert/strict';
import test from 'node:test';
import { dominantScriptFamily } from '../../src/shared/script_detection.ts';

const ENGLISH = 'Romantic rejection activates the same brain regions implicated in physical pain.';
const JAPANESE = '日本語のテキストはひらがなとカタカナと漢字を混ぜて書かれています。';
const CHINESE = '人工智能正在改变人们获取知识的方式，很多新工具让人难以跟上。';
const KOREAN = '인공지능은 사람들이 지식을 얻는 방식을 바꾸고 있습니다.';
const RUSSIAN = 'Искусственный интеллект меняет способ получения знаний людьми.';
const ARABIC = 'الذكاء الاصطناعي يغير طريقة حصول الناس على المعرفة كل يوم.';
const THAI = 'ปัญญาประดิษฐ์กำลังเปลี่ยนวิธีที่ผู้คนเข้าถึงความรู้ในทุกวันนี้';
const GREEK = 'Η τεχνητή νοημοσύνη αλλάζει τον τρόπο πρόσβασης στη γνώση.';
const HEBREW = 'הבינה המלאכותית משנה את הדרך שבה אנשים רוכשים ידע.';
const HINDI = 'कृत्रिम बुद्धिमत्ता लोगों के ज्ञान प्राप्त करने के तरीके को बदल रही है।';

test('names the family of each non-Latin script', () => {
	assert.equal(dominantScriptFamily(JAPANESE), 'ja');
	assert.equal(dominantScriptFamily(CHINESE), 'zh');
	assert.equal(dominantScriptFamily(KOREAN), 'ko');
	assert.equal(dominantScriptFamily(RUSSIAN), 'cyrillic');
	assert.equal(dominantScriptFamily(ARABIC), 'arabic');
	assert.equal(dominantScriptFamily(THAI), 'thai');
	assert.equal(dominantScriptFamily(GREEK), 'greek');
	assert.equal(dominantScriptFamily(HEBREW), 'hebrew');
	assert.equal(dominantScriptFamily(HINDI), 'devanagari');
});

test('reports latin for Latin-script prose', () => {
	assert.equal(dominantScriptFamily(ENGLISH), 'latin');
});

test('kana decides Japanese even when Han characters outnumber it', () => {
	// A headline that is mostly kanji still carries okurigana; Chinese never does.
	assert.equal(dominantScriptFamily('人工知能技術研究所の最新報告書によると、これは重要な変化である。'), 'ja');
});

test('a quoted foreign phrase does not flip the family', () => {
	assert.equal(dominantScriptFamily(`${ENGLISH} The author's name is 王小明.`), 'latin');
});

test('returns null when no script reaches the dominance threshold', () => {
	assert.equal(dominantScriptFamily('123 456 --- 789'), null);
	assert.equal(dominantScriptFamily(''), null);
});
