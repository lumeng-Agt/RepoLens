export type SearchMatcherOptions = { query: string; regex?: boolean; wholeWord?: boolean; matchCase?: boolean };
export type SearchMatchDescription = {
  text: string;
  contextStartColumn: number;
  contextEndColumn: number;
  lineLength: number;
  matchStartColumn: number;
  matchEndColumn: number;
};

export function buildSearchMatcher(options: SearchMatcherOptions): RegExp;
export function describeSearchMatch(line: string, match: RegExpExecArray): SearchMatchDescription;
export function splitSearchHighlight(result: Pick<SearchMatchDescription, "text" | "contextStartColumn" | "matchStartColumn" | "matchEndColumn">): { before: string; match: string; after: string };
