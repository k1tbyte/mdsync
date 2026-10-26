import type { FileRow, MutableTreeNode, TreeNode, VisualRow } from "./types";

export function buildTree(rows: ReadonlyArray<FileRow>): TreeNode {
	const root = createFolderNode("", "");
	for (const row of rows) {
		const parts = row.path.split("/");
		let current = root;
		let prefix = "";
		for (let i = 0; i < parts.length - 1; i++) {
			const name = parts[i] as string;
			prefix = prefix ? `${prefix}/${name}` : name;
			let child = current.folders.get(name);
			if (!child) {
				child = createFolderNode(name, prefix);
				current.folders.set(name, child);
				current.children.push(child);
			}
			current = child;
		}
		current.children.push({
			name: parts[parts.length - 1] as string,
			fullPath: row.path,
			row,
			children: [],
		});
	}
	return root;
}

function createFolderNode(name: string, fullPath: string): MutableTreeNode {
	return { name, fullPath, children: [], folders: new Map() };
}

/** Walks the tree in display order, skipping what a collapsed folder hides, so collapsing saves work. */
export function flattenTree(
	node: TreeNode,
	isExpanded: (folderPath: string) => boolean,
	depth = 0,
	out: VisualRow[] = [],
): VisualRow[] {
	for (const child of node.children) {
		if (child.row) {
			out.push({ depth, name: child.name, row: child.row });
			continue;
		}
		// A chain of lone subfolders is one row, keyed by its deepest folder.
		let folder = child;
		let name = child.name;
		while (folder.children.length === 1 && !folder.children[0]?.row) {
			folder = folder.children[0] as TreeNode;
			name = `${name}/${folder.name}`;
		}
		const collapsed = !isExpanded(folder.fullPath);
		out.push({ depth, name, folderPath: folder.fullPath, collapsed });
		if (!collapsed) flattenTree(folder, isExpanded, depth + 1, out);
	}
	return out;
}

export function flattenRows(rows: ReadonlyArray<FileRow>): VisualRow[] {
	return rows.map((row) => ({ depth: 0, name: row.path, row }));
}
