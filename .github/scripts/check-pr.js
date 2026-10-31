const SECTIONS = ['What', 'Why', 'Proof', 'Tested on', 'Checklist'];
const MEDIA = /!\[[^\]]*\]\([^)]+\)|<img\s|<video\s|https:\/\/github\.com\/user-attachments\/assets\/[\w-]+|\.(png|jpe?g|gif|mp4|mov|webm)\b/i;
const CONVENTIONAL = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([\w-]+\))?!?: \S.{0,70}$/;
const ATTRIBUTION = /^(co-authored-by:.*\b(claude|copilot|chatgpt|openai|anthropic|gemini|cursor|codex)\b|.*generated (with|by) .*(claude|copilot|chatgpt|ai\b))/im;
const SLOP = /\b(comprehensive|robust|seamless(ly)?|leverag(e|es|ing)|delve|holistic|this pr introduces)\b/i;
const MAX_WORDS = 250;
const MARKER = '<!-- pr-format-check -->';

function sections(body) {
  const text = body.replace(/<!--[\s\S]*?-->/g, '');
  const found = {};
  for (const part of text.split(/^##\s+/m).slice(1)) {
    const [heading, ...rest] = part.split('\n');
    found[heading.trim()] = rest.join('\n').trim();
  }
  return found;
}

function check({ title, body, files, commits }) {
  const problems = [];
  if (!CONVENTIONAL.test(title)) problems.push(`Use a Conventional Commit PR title ("feat(dylib): …"), got "${title}".`);
  const found = sections(body || '');
  for (const name of SECTIONS) if (!found[name]) problems.push(`Fill in the "## ${name}" section.`);
  for (const item of (found.Checklist || '').match(/^- \[ \] .+$/gm) || []) problems.push(`Tick the checklist: "${item.slice(6)}".`);
  if (files.some((f) => f.startsWith('src/dylib/')) && !MEDIA.test(found.Proof || ''))
    problems.push('This changes what Dia looks like: add a screenshot (or a screen recording if it animates) under "## Proof".');

  const prose = Object.entries(found).filter(([k]) => k !== 'Proof').map(([, v]) => v).join(' ');
  const words = prose.replace(/https?:\/\/\S+/g, '').split(/\s+/).filter(Boolean).length;
  if (words > MAX_WORDS) problems.push(`Keep the description under ${MAX_WORDS} words (it has ${words}).`);
  const slop = prose.match(SLOP);
  if (slop) problems.push(`Rewrite in plain words: "${slop[0]}".`);

  for (const { sha, message } of commits) {
    const subject = message.split('\n')[0];
    if (!CONVENTIONAL.test(subject)) problems.push(`${sha.slice(0, 7)}: use a Conventional Commit subject ("fix(dylib): …"), got "${subject}".`);
    if (ATTRIBUTION.test(message)) problems.push(`${sha.slice(0, 7)}: remove the AI attribution trailer.`);
  }
  if (problems.some((p) => /^[0-9a-f]{7}:/.test(p)))
    problems.push('To fix commit messages: `git rebase -i origin/main`, mark them `reword`, then `git push --force-with-lease`.');
  return problems;
}

module.exports = async ({ github, context, core }) => {
  const pr = context.payload.pull_request;
  const params = { owner: context.repo.owner, repo: context.repo.repo, pull_number: pr.number, per_page: 100 };
  const files = (await github.paginate(github.rest.pulls.listFiles, params)).map((f) => f.filename);
  const commits = (await github.paginate(github.rest.pulls.listCommits, params)).map((c) => ({ sha: c.sha, message: c.commit.message }));
  const problems = check({ title: pr.title, body: pr.body, files, commits });

  // One comment per PR, edited in place, removed once everything passes.
  const issue = { owner: params.owner, repo: params.repo, issue_number: pr.number };
  const comments = await github.paginate(github.rest.issues.listComments, issue);
  const existing = comments.find((c) => c.user.type === 'Bot' && c.body.startsWith(MARKER));
  if (!problems.length) {
    if (existing) await github.rest.issues.deleteComment({ ...issue, comment_id: existing.id });
    return;
  }
  const list = problems.map((p) => `- ${p}`).join('\n');
  const body = `${MARKER}\nThis PR doesn't follow [CONTRIBUTING.md](https://github.com/${params.owner}/${params.repo}/blob/main/CONTRIBUTING.md) yet:\n\n${list}\n\nThis comment updates as you push or edit the description.`;
  if (existing) await github.rest.issues.updateComment({ ...issue, comment_id: existing.id, body });
  else await github.rest.issues.createComment({ ...issue, body });
  core.setFailed(list);
};

module.exports.check = check;
