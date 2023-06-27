export const mypyOutputPattern =
	/^(?<location>(?<file>[^\n]+?):(?<line>\d+):(?<column>\d+):(?<endLine>\d+):(?<endColumn>\d+)): (?<type>\w+): (?<message>.*?)(?:  \[(?<code>[\w-]+)\])?$/;
