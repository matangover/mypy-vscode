const r = String.raw;
const endLocation = r`(:(?<endLine>\d+):(?<endColumn>\d+))?`;
const location = r`(?<location>(?<file>.+?):(?<line>\d+):(?<column>\d+)${endLocation})`;
const code = r`(?:  \[(?<code>[\w-]+)\])?`;
const mypyOutputLine =
	r`^${location}: (?<type>\w+): (?<message>.*?)${code}$`;
export const mypyOutputPattern = new RegExp(mypyOutputLine);

export type MypyOutputLine = {
	location: string;
	file: string;
	line: string;
	column: string;
	endLine?: string;
	endColumn?: string;
	type: string;
	message: string;
	code?: string;
}
