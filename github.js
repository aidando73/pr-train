// @ts-check
const octo = require('octonode');
const promptly = require('promptly');
const {
  DEFAULT_REMOTE,
  DEFAULT_BASE_BRANCH,
} = require('./consts');
const fs = require('fs');
const get = require('lodash/get');
const colors = require('colors');
const emoji = require('node-emoji');
const width = require('string-width');
const { exit } = require('process');

/**
 *
 * @param {simpleGit.SimpleGit} sg
 * @param {string} branch
 * @return Promise.<{title: string, body: string}>
 */
async function constructPrMsg(sg, branch) {
  const title = await sg.raw(['log', '--format=%s', '-n', '1', branch]);
  const body = await sg.raw(['log', '--format=%b', '-n', '1', branch]);
  return {
    title: title.trim(),
    body: body.trim(),
  };
}

/**
 *
 * @param {Object.<string, {title: string, pr: number}>} branchToPrDict
 * @param {string} currentBranch
 * @param {string} combinedBranch
 */
function constructTrainNavigation(branchToPrDict, currentBranch, combinedBranch) {
  let contents = '<pr-train-toc>\n\n';
  let prList = [];
  Object.keys(branchToPrDict).forEach((branch) => {
    const maybeHandRight = branch === currentBranch ? ' 👈' : ' ';
    const combinedInfo = branch === combinedBranch ? ' **[combined branch]** ' : ' ';
    const prNumber = `#${branchToPrDict[branch].pr}`;
    const prInfoHtml = `1. ${prNumber}${combinedInfo}${maybeHandRight}`;
    prList.push(prInfoHtml);
  });
  contents += '### PR Train\n';
  contents += prList.join('\n');
  contents += '\n</pr-train-toc>';
  return contents;
}

/**
 *
 * @param {string} context
 */
function constructContextSection(context) {
  let contents = '<pr-train-context>\n\n';
  contents += '### Context\n';
  contents += context + '\n';
  contents += '</pr-train-context>\n\n';
  return contents;
}

function checkGHKeyExists() {
  try {
    readGHKey();
  } catch (e) {
    console.log(`"$HOME/.pr-train" not found. Please make sure file exists and contains your GitHub API key.`.red);
    process.exit(4);
  }
}

function readGHKey() {
  return fs
    .readFileSync(`${process.env.HOME}/.pr-train`, 'UTF-8')
    .toString()
    .trim();
}

/**
 *
 * @param {string} newNavigation
 * @param {string} body
 */
function upsertNavigationInBody(newNavigation, body) {
  body = body || '';
  if (body.match(/<pr-train-toc>/)) {
    return body.replace(/<pr-train-toc>[^]*<\/pr-train-toc>/, newNavigation);
  } else {
    return (body ? body + '\n' : '') + newNavigation;
  }
}

/**
 * @param {string} contextSection
 * @param {string} body
 */
function upsertContextSectionInBody(contextSection, body) {
  body = body || '';
  if (body.match(/<pr-train-context>/)) {
    return body.replace(/<pr-train-context>[^]*<\/pr-train-context>/, contextSection);
  } else {
    return contextSection + (body ? body + '\n' : '');
  }
}

function upsertFeedbackForm(body) {
  body = body || '';
  let feedbackForm = '<pr-train-feedback>\n\n';
  feedbackForm += '#### Feedback\n';
  feedbackForm += '- Have feedback that doesn’t quite belong in this PR?\n';
  feedbackForm += '- If you have 2-5 minutes, I always appreciate getting feedback\n';
  feedbackForm += '- [Feedback form](https://forms.gle/JNJUd3pda73myPgP7) 👈 (Responses are anonymous)\n';
  feedbackForm += '</pr-train-feedback>';
  if (body.match(/<pr-train-feedback>/)) {
    return body.replace(/<pr-train-feedback>[^]*<\/pr-train-feedback>/, feedbackForm);
  } else {
    return body + feedbackForm;
  }
}


function checkAndReportInvalidBaseError(e, base) {
  const { field, code } = get(e, 'body.errors[0]', {});
  if (field === 'base' && code === 'invalid') {
    console.log([
      emoji.get('no_entry'),
      `\n${emoji.get('confounded')} This is embarrassing. `,
      `The base branch of ${base.bold} doesn't seem to exist on the remote.`,
      `\nDid you forget to ${emoji.get('arrow_up')} push it?`,
    ].join(''));
    return true;
  }
  return false;
}

/**
 *
 * @param {simpleGit.SimpleGit} sg
 * @param {Array.<string>} allBranches
 * @param {string} combinedBranch
 * @param {boolean} draft
 * @param {string} remote
 * @param {string} baseBranch
 * @param {boolean} printLinks
 * @param {string} trainBase the branch marked as base. Usually the next branch to be merged in the train.
 */
async function ensurePrsExist({
                                sg,
                                allBranches,
                                combinedBranch,
                                draft,
                                remote = DEFAULT_REMOTE,
                                baseBranch = DEFAULT_BASE_BRANCH,
                                printLinks = false,
                                context = '',
                                trainBase,
                              }) {
  //const allBranches = combinedBranch ? sortedBranches.concat(combinedBranch) : sortedBranches;
  const octoClient = octo.client(readGHKey());
  // TODO: take remote name from `-r` value.
  const nickAndRepo = await getRepoName({ sg, remote });

  /** @type string */
  let combinedBranchTitle;
  if (combinedBranch) {
    console.log();
    console.log(`Now I will need to know what to call your "combined" branch PR in GitHub.`);
    combinedBranchTitle = await promptly.prompt(colors.bold(`Combined branch PR title:`));
    if (!combinedBranchTitle) {
      console.log(`Cannot continue.`.red, `(I need to know what the title of your combined branch PR should be.)`);
      process.exit(5);
    }
  }

  const getCombinedBranchPrMsg = () => ({
    title: combinedBranchTitle,
    body: '',
  });

  const prText = draft ? 'draft PR' : 'PR';

  console.log();
  console.log(`This will create (or update) ${prText}s for the following branches:`);
  await allBranches.reduce(async (memo, branch) => {
    await memo;
    const {
      title,
    } = branch === combinedBranch ? getCombinedBranchPrMsg() : await constructPrMsg(sg, branch);
    console.log(`  -> ${branch.green} (${title.italic})`);
  }, Promise.resolve());

  console.log();
  if (!(await promptly.confirm(colors.bold('Shall we do this? [y/n] ')))) {
    console.log('No worries. Bye now.', emoji.get('wave'));
    process.exit(0);
  }


  const nick = nickAndRepo.split('/')[0];
  const ghRepo = octoClient.repo(nickAndRepo);

  console.log('');
  // Construct branch_name <-> PR_data mapping.
  // Note: We're running this serially to have nicer logs.
  /**
   * @type Object.<string, {title: string, pr: number, body: string, updating: boolean}>
   */
  const prDict = await allBranches.reduce(async (_memo, branch, index) => {
    const memo = await _memo;
    const {
      title,
      body,
    } = branch === combinedBranch ? getCombinedBranchPrMsg() : await constructPrMsg(sg, branch);
    const base = index === 0 || branch === combinedBranch || branch === trainBase ? baseBranch : allBranches[index - 1];
    process.stdout.write(`Checking if PR for branch ${branch} already exists... `);
    const prs = await ghRepo.prsAsync({
      state: 'all',
      sort: 'created',
      direction: 'desc',
      head: `${nick}:${branch}`,
    });
    const prsBody = prs[0];
    // Use the oldest one for now
    let prResponse = prsBody && prsBody[prsBody.length - 1];
    let prExists = false;
    if (prResponse) {
      console.log('yep');
      prExists = true;
    } else {
      console.log('nope');
      const payload = {
        head: branch,
        base,
        title,
        body,
        draft,
      };
      const baseMessage = base === baseBranch ? colors.dim(` (against ${base})`) : '';
      process.stdout.write(`Creating ${prText} for branch "${branch}"${baseMessage}...`);
      try {
        prResponse = (await ghRepo.prAsync(payload))[0];
      } catch (e) {
        if (!checkAndReportInvalidBaseError(e, base)) {
          console.error(JSON.stringify(e, null, 2));
        }
        throw e;
      }
      console.log(emoji.get('white_check_mark'));
    }
    memo[branch] = {
      body: prResponse.body,
      title: prResponse.title,
      pr: prResponse.number,
      updating: prExists,
    };
    return memo;
  }, Promise.resolve({}));

  // Now that we have all the PRs, let's update them with the "navigation" section.
  // Note: We're running this serially to have nicer logs.
  await allBranches.reduce(async (memo, branch) => {
    await memo;
    const prInfo = prDict[branch];
    const ghPr = octoClient.pr(nickAndRepo, prInfo.pr);
    const {
      title,
      body,
    } = prInfo.updating ?
      prInfo // Updating existing PR: keep current body and title.
      :
      branch === combinedBranch ?
        getCombinedBranchPrMsg() :
        await constructPrMsg(sg, branch);
    const navigation = constructTrainNavigation(prDict, branch, combinedBranch);
    let newBody = upsertNavigationInBody(navigation, body);
    if (context) {
      const contextSection = constructContextSection(context);
      newBody = upsertContextSectionInBody(contextSection, newBody);
    }
    newBody = upsertFeedbackForm(newBody);
    process.stdout.write(`Updating PR for branch ${branch}...`);
    const updateResponse = await ghPr.updateAsync({
      title,
      body: `${newBody}`,
    });
    const prLink = get(updateResponse, '0._links.html.href', colors.yellow('Could not get URL'));
    console.log(emoji.get('white_check_mark') + (printLinks ? ` (${prLink})` : ''));
  }, Promise.resolve());

  return prDict;
}

async function getRepoName({ sg, remote = DEFAULT_REMOTE }) {
  const remoteUrl = await sg.raw(['config', '--get', `remote.${remote}.url`]);
  if (!remoteUrl) {
    console.log(`URL for remote ${remote} not found in your git config`.red);
    process.exit(4);
  }

  const nickAndRepo = remoteUrl.match(/github\.com[/:](.*)/)[1].replace(/\.git$/, '');
  if (!nickAndRepo) {
    console.log(`I could not parse your remote ${remote} repo URL`.red);
    process.exit(4);
  }
  return nickAndRepo;
}

/**
 * Returns false if PR is either:
 * - not found
 * - or open
 */
async function isPrClosed({
                            sg,
                            branch,
                            remote = DEFAULT_REMOTE,
                          }) {
  if (!branch) {
    console.log(`Branch name is required to check PR status`.red);
    process.exit(4);
  }
  const octoClient = octo.client(readGHKey());
  const orgAndRepo = await getRepoName({ sg, remote });
  const org = orgAndRepo.split('/')[0];
  const ghRepo = octoClient.repo(orgAndRepo);
  const prs = await ghRepo.prsAsync({
    state: 'closed',
    sort: 'created',
    direction: 'desc',
    head: `${org}:${branch}`,
  });
  // Use the oldest one for now
  const prsBody = prs[0];
  return Boolean(prsBody && prsBody[prsBody.length - 1]);
}

module.exports = {
  ensurePrsExist,
  isPrClosed,
  readGHKey,
  checkGHKeyExists,
  getRepoName,
};
