export const ESection = {
	Conflicts: "conflicts",
	Local: "local",
	Remote: "remote",
} as const;
export type ESection = (typeof ESection)[keyof typeof ESection];

export interface FileRow {
	path: string;
	/** Where a moved file was. */
	from?: string;
	size?: number;
	sizeDelta?: number;
	statusLetter: string;
	statusClass: string;
	isConflict: boolean;
}

export interface TreeNode {
	name: string;
	fullPath: string;
	row?: FileRow;
	children: TreeNode[];
}

/**
 * One on-screen line: flattening the tree makes a collapsed folder cost one row and gives the virtual list
 * an index.
 */
export interface VisualRow {
	depth: number;
	name: string;
	/** A file row; a folder row has none. */
	row?: FileRow;
	/** A folder row; the path its expanded state is keyed by. */
	folderPath?: string;
	collapsed?: boolean;
}

export interface MutableTreeNode extends TreeNode {
	folders: Map<string, MutableTreeNode>;
}
