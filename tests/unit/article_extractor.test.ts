import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanContentTree, getTextBlocks } from '../../src/content/article_extractor.ts';

interface MockNodeInit {
	tagName?: string;
	id?: string;
	className?: string;
	role?: string;
	text?: string;
	children?: Array<MockNodeInit | string>;
}

class FakeNode {
	nodeType: number;
	tagName: string;
	id: string;
	className: string;
	role: string;
	textContent: string;
	parentElement: FakeNode | null = null;
	childNodes: FakeNode[] = [];

	constructor(init: MockNodeInit | string) {
		if (typeof init === 'string') {
			this.nodeType = 3; // TEXT_NODE
			this.tagName = '';
			this.id = '';
			this.className = '';
			this.role = '';
			this.textContent = init;
		} else {
			this.nodeType = 1; // ELEMENT_NODE
			this.tagName = (init.tagName || 'DIV').toUpperCase();
			this.id = init.id || '';
			this.className = init.className || '';
			this.role = init.role || '';
			this.textContent = init.text || '';

			if (init.text) {
				const textChild = new FakeNode(init.text);
				textChild.parentElement = this;
				this.childNodes.push(textChild);
			}

			if (init.children) {
				for (const childInit of init.children) {
					const child = new FakeNode(childInit);
					child.parentElement = this;
					this.childNodes.push(child);
				}
			}
		}
	}

	getAttribute(name: string): string | null {
		if (name === 'role') return this.role || null;
		return null;
	}

	remove(): void {
		if (this.parentElement) {
			const idx = this.parentElement.childNodes.indexOf(this);
			if (idx >= 0) {
				this.parentElement.childNodes.splice(idx, 1);
			}
			this.parentElement = null;
		}
	}

	querySelector(selector: string): FakeNode | null {
		const target = selector.toUpperCase();
		const queue: FakeNode[] = [...this.childNodes];
		while (queue.length > 0) {
			const current = queue.shift()!;
			if (current.nodeType === 1) {
				if (current.tagName === target || (target === 'BR' && current.tagName === 'BR')) {
					return current;
				}
				queue.push(...current.childNodes);
			}
		}
		return null;
	}

	querySelectorAll(selector: string): FakeNode[] {
		const target = selector.toUpperCase();
		const results: FakeNode[] = [];
		const queue: FakeNode[] = [...this.childNodes];
		while (queue.length > 0) {
			const current = queue.shift()!;
			if (current.nodeType === 1) {
				if (
					current.tagName === target ||
					current.tagName.toLowerCase() === selector.toLowerCase() ||
					selector === '*' ||
					(selector === '[id], [class]' && (current.id || current.className))
				) {
					results.push(current);
				}
				queue.push(...current.childNodes);
			}
		}
		return results;
	}
}

class FakeTreeWalker {
	root: FakeNode;
	currentNode: FakeNode;
	private stack: FakeNode[] = [];

	constructor(root: FakeNode) {
		this.root = root;
		this.currentNode = root;
		this.buildTraversalStack(root);
	}

	private buildTraversalStack(node: FakeNode) {
		this.stack.push(node);
		for (const child of node.childNodes) {
			if (child.nodeType === 1) {
				this.buildTraversalStack(child);
			}
		}
	}

	nextNode(): FakeNode | null {
		const idx = this.stack.indexOf(this.currentNode);
		if (idx >= 0 && idx + 1 < this.stack.length) {
			this.currentNode = this.stack[idx + 1];
			return this.currentNode;
		}
		return null;
	}

	nextSibling(): FakeNode | null {
		if (!this.currentNode.parentElement) return null;
		const siblings = this.currentNode.parentElement.childNodes.filter((n) => n.nodeType === 1);
		const idx = siblings.indexOf(this.currentNode);
		if (idx >= 0 && idx + 1 < siblings.length) {
			this.currentNode = siblings[idx + 1];
			return this.currentNode;
		}
		return null;
	}

	parentNode(): FakeNode | null {
		if (this.currentNode.parentElement) {
			this.currentNode = this.currentNode.parentElement;
			return this.currentNode;
		}
		return null;
	}
}

class FakeTextTreeWalker {
	private textNodes: FakeNode[] = [];
	private index = -1;

	constructor(root: FakeNode) {
		this.collectTextNodes(root);
	}

	private collectTextNodes(node: FakeNode) {
		for (const child of node.childNodes) {
			if (child.nodeType === 3) {
				this.textNodes.push(child);
			} else if (child.nodeType === 1) {
				this.collectTextNodes(child);
			}
		}
	}

	nextNode(): FakeNode | null {
		this.index++;
		return this.textNodes[this.index] || null;
	}
}

export function createFakeArticleRoot(children: MockNodeInit[]): any {
	const rootNode = new FakeNode({
		tagName: 'ARTICLE',
		children,
	});

	const doc: any = {
		createTreeWalker: (root: any, filter: number) => {
			if (filter === 4 || filter === 0x4) {
				return new FakeTextTreeWalker(root);
			}
			return new FakeTreeWalker(root);
		},
	};

	const setOwnerDoc = (n: FakeNode) => {
		(n as any).ownerDocument = doc;
		n.childNodes.forEach(setOwnerDoc);
	};
	setOwnerDoc(rootNode);

	return rootNode as any;
}

test('extracts XenForo bullet list separated by BR tags into distinct blocks', () => {
	const root = createFakeArticleRoot([
		{
			tagName: 'DIV',
			className: 'xfBody',
			children: [
				{
					tagName: 'SPAN',
					className: 'xf-body-paragraph',
					children: [
						'Hành trình từ 1 triệu đến 10 triệu chỉ trong 6 năm',
						{ tagName: 'BR' },
						'• 1 triệu — Ngày 9 tháng Ba năm 2020',
						{ tagName: 'BR' },
						'• 2 triệu — Tháng Chín 2021',
						{ tagName: 'BR' },
						'• 3 triệu — Tháng Tám năm 2022',
					],
				},
			],
		},
	]);

	const blocks = getTextBlocks(root);
	assert.ok(blocks.includes('• 1 triệu — Ngày 9 tháng Ba năm 2020'));
	assert.ok(blocks.includes('• 2 triệu — Tháng Chín 2021'));
	assert.ok(blocks.includes('• 3 triệu — Tháng Tám năm 2022'));
});

test('prevents duplicate extraction when element has no next sibling (skipSubtree test)', () => {
	const root = createFakeArticleRoot([
		{
			tagName: 'DIV',
			className: 'xfBody',
			children: [
				{
					tagName: 'SPAN',
					className: 'xf-body-paragraph',
					children: [
						'Sáu tháng đầu năm 2026, công ty sản xuất khoảng 860.000 xe. Tuy nhiên, công suất lắp đặt toàn cầu hiện đã vượt ',
						{ tagName: 'B', text: '2,35–2,375 triệu xe/năm' },
						', nhưng sản lượng thực tế vẫn bị hạn chế.',
					],
				},
			],
		},
	]);

	const blocks = getTextBlocks(root);
	const matches = blocks.filter((b) => b.includes('2,35–2,375 triệu xe/năm'));
	// Must appear inside the paragraph block, NEVER as a separate standalone duplicate block
	assert.equal(matches.length, 1);
});

test('merges direct text nodes and short inline formatting tags into a single paragraph', () => {
	const root = createFakeArticleRoot([
		{
			tagName: 'DIV',
			className: 'xfBody',
			children: [
				'Tốc độ này tương đương khoảng ',
				{ tagName: 'B', text: '4.800 xe/ngày' },
				' trên toàn bộ mạng lưới nhà máy toàn cầu. Từ chiếc Roadster đầu tiên giao khách năm 2008 đến nay, Tesla mất khoảng ',
				{ tagName: 'B', text: '18 năm 5 tháng' },
				' để đạt 10 triệu xe.',
			],
		},
	]);

	const blocks = getTextBlocks(root);
	assert.equal(
		blocks[0],
		'Tốc độ này tương đương khoảng 4.800 xe/ngày trên toàn bộ mạng lưới nhà máy toàn cầu. Từ chiếc Roadster đầu tiên giao khách năm 2008 đến nay, Tesla mất khoảng 18 năm 5 tháng để đạt 10 triệu xe.',
	);
});

test('filters out promo and ad noise blocks without dropping headings with menuid0', () => {
	const root = createFakeArticleRoot([
		{
			tagName: 'H3',
			id: 'menuid0',
			className: 'TinhteMods_HeadingTag',
			children: [{ tagName: 'B', text: 'Hành trình từ 1 triệu đến 10 triệu chỉ trong 6 năm' }],
		},
		{
			tagName: 'P',
			className: 'in-article-promo-title',
			text: 'Quảng cáo',
		},
	]);

	cleanContentTree(root);
	const blocks = getTextBlocks(root);

	assert.ok(blocks.includes('Hành trình từ 1 triệu đến 10 triệu chỉ trong 6 năm'));
	assert.equal(blocks.includes('Quảng cáo'), false);
});

test('filters out category metadata noise (e.g. Znews category badge) and preserves linear DOM order', () => {
	const root = createFakeArticleRoot([
		{
			tagName: 'HEADER',
			className: 'the-article-header',
			children: [
				{
					tagName: 'P',
					className: 'category',
					children: [{ tagName: 'A', text: 'Xuất bản' }],
				},
				{
					tagName: 'H1',
					className: 'the-article-title',
					text: 'Thấy gì từ thỏa thuận dàn xếp 1,5 tỷ USD của công ty mẹ Claude?',
				},
				{
					tagName: 'UL',
					className: 'the-article-meta',
					children: [
						{ tagName: 'LI', className: 'author', text: 'Đức An' },
						{ tagName: 'LI', className: 'pubdate', text: 'Thứ ba, 4/8/2026 08:58 (GMT+7)' },
					],
				},
			],
		},
		{
			tagName: 'P',
			className: 'the-article-summary',
			text: 'Anthropic, công ty mẹ của Claude, đã chấp nhận dàn xếp...',
		},
	]);

	cleanContentTree(root);
	const blocks = getTextBlocks(root);

	assert.equal(blocks.includes('Xuất bản'), false);
	assert.equal(blocks[0], 'Thấy gì từ thỏa thuận dàn xếp 1,5 tỷ USD của công ty mẹ Claude?');
});
