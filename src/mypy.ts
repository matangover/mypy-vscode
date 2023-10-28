export const mypyOutputPattern =
	/^(?<location>(?<file>[^\n]+?):(?<line>\d+):(?<column>\d+):(?<endLine>\d+):(?<endColumn>\d+)): (?<type>\w+): (?<message>.*?)(?:  \[(?<code>[\w-]+)\])?$/;

export type MypyOutputLine = {
	location: string;
	file: string;
	line: string;
	column: string;
	endLine: string;
	endColumn: string;
	type: string;
	message: string;
	code?: string;
}
