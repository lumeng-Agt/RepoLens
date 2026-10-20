export function readingBaselineHeadRef(repository) {
  return repository?.origin?.kind === "github" ? repository.origin.commit : "HEAD";
}
