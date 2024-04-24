import { existsSync } from 'fs';
import { join } from 'path';
import { ExpandedMergeRequestSchema } from '@gitbeaker/core';
import { Gitlab, MergeRequestDiffSchema, MergeRequestDiscussionNotePositionOptions, ProjectSchema } from '@gitbeaker/rest';
import { getFileSystem, llms } from '#agent/agentContext';
import { func } from '#agent/functions';
import { funcClass } from '#agent/metadata';
import { logger } from '#o11y/logger';
import { span } from '#o11y/trace';
import { allSettledAndFulFilled } from '#utils/async-utils';
import { envVar } from '#utils/env-var';
import { checkExecResult, execCmd, execCommand } from '#utils/exec';
import { cacheRetry } from '../../cache/cache';
import { ICodeReview, loadCodeReviews } from '../../swe/codeReview/codeReviewParser';
import { UtilFunctions } from '../util';
import { SourceControlManagement } from './sourceControlManagement';

export interface GitLabConfig {
	host: string;
	token: string;
	secretName?: string;
	secretProject?: string;
	topLevelGroups: string[];
	groupExcludes?: Set<string>;
}

/**
 * AI review of a git diff
 */
type DiffReview = {
	mrDiff: MergeRequestDiffSchema;
	/** The code being reviewed from the diff */
	code: string;
	/** Code review comments */
	comments: Array<{ comment: string; lineNumber: number }>;
};

export type GitLabProject = Pick<
	ProjectSchema,
	| 'id'
	| 'name'
	| 'description'
	| 'path_with_namespace'
	| 'http_url_to_repo'
	| 'default_branch'
	| 'archived'
	// | "shared_with_groups"
	| 'visibility'
	| 'owner'
	| 'ci_config_path'
>;

@funcClass(__filename)
export class GitLabServer implements SourceControlManagement {
	api;
	host;
	config: GitLabConfig;

	constructor(config?: GitLabConfig) {
		this.host = envVar('GITLAB_HOST');
		this.config = config ?? {
			host: this.host,
			token: envVar('GITLAB_TOKEN'),
			topLevelGroups: JSON.parse(envVar('GITLAB_GROUPS')),
		};
		this.api = new Gitlab({
			host: `https://${this.config.host}`,
			token: this.config.token,
		});
	}

	toJSON() {
		return {
			host: this.host,
		};
	}

	// /**
	//  * Searches the descriptions of all the projects in GitLab to find the project which has the files to edit to complete the requirements
	//  * @param requirements the task requirements
	//  * @returns the GitLab project details (name, git URL etc)
	//  */
	// async selectProject(requirements: string): Promise<GitLabProject> {
	// 	const projects = await this.getProjects();
	// 	const prompt = buildPrompt({
	// 		information: `The following is a list of our projects:\n<projects>${JSON.stringify(projects)}</projects>`,
	// 		requirements,
	// 		action:
	// 			'Select the project object which most closely matches the task and return the object. Output your answer in JSON format',
	// 	});
	//
	// 	const project = await llms().medium.generateTextAsJson(prompt);
	// 	return project;
	// }

	/**
	 * @returns the details of all the projects available (name, description, git URL etc)
	 */
	@cacheRetry({ scope: 'global' })
	async getProjects(): Promise<any[]> {
		const resultProjects: GitLabProject[] = [];
		for (const group of this.config.topLevelGroups) {
			const projects = await this.api.Groups.allProjects(group, {
				orderBy: 'name',
				perPage: 100,
			});
			// console.log(`${group} ==========`);
			projects.sort((a, b) => a.path.localeCompare(b.path));
			projects.map((project) => this.toGitLabProject(project)).forEach((project) => resultProjects.push(project));

			const descendantGroups = await this.api.Groups.allDescendantGroups(group, {});
			for (const descendantGroup of descendantGroups) {
				if (descendantGroup.full_name.includes('Archive')) continue;
				if (this.config.groupExcludes?.has(descendantGroup.full_path)) continue;

				// console.log(`${descendantGroup.full_path} ==========`);
				const pageSize = 100;
				const projects = await this.api.Groups.allProjects(descendantGroup.id, {
					orderBy: 'name',
					perPage: 100,
				});
				if (projects.length >= pageSize) {
					throw new Error(`Need pagination for projects for group ${group}. Returned more than ${pageSize}`);
				}
				projects.sort((a, b) => a.path.localeCompare(b.path));
				projects.map((project) => this.toGitLabProject(project)).forEach((project) => resultProjects.push(project));
			}
		}

		return resultProjects;
	}

	private toGitLabProject(project: ProjectSchema): GitLabProject {
		return {
			id: project.id,
			name: project.name,
			description: project.description,
			path_with_namespace: project.path_with_namespace,
			http_url_to_repo: project.http_url_to_repo,
			default_branch: project.default_branch,
			archived: project.archived,
			visibility: project.visibility,
			owner: project.owner,
			ci_config_path: project.ci_config_path,
		};
	}

	/**
	 * Clones a project from GitLab to the file system. To use this project the function FileSystem.setWorkingDirectory must be called after with the returned value
	 * @param projectPathWithNamespace the full project path in GitLab
	 * @returns the path in the FileSystem containing the repository files
	 */
	@func()
	async cloneProject(projectPathWithNamespace: string): Promise<string> {
		const path = join(getFileSystem().getWorkingDirectory(), 'gitlab', projectPathWithNamespace);

		// If the project already exists pull updates
		if (existsSync(path) && existsSync(join(path, '.git'))) {
			const result = await execCmd(`git -C ${path} pull`);
			checkExecResult(result, `Failed to pull unshallow ${path}`);
		} else {
			console.log(`Cloning to ${path}`);
			const command = `git clone https://oauth2:${this.config.token}@${this.config.host}/${projectPathWithNamespace}.git ${path}`;
			const result = await execCmd(command);
			checkExecResult(result, `Failed to clone ${projectPathWithNamespace}`);
		}
		return path;
	}

	/**
	 * Creates a Merge request
	 * @param title {string} The title of the merge request
	 * @param description {string} The description of the merge request
	 */
	@func()
	async createMergeRequest(title: string, description: string): Promise<string> {
		// TODO lookup project details from project list
		// get main branch. If starts with feature and dev develop exists, then that
		const currentBranch = getFileSystem().vcs.getBranchName();

		const targetBranch = 'master'; // TODO get from the GitLab project

		const cmd = `git push --set-upstream origin "${currentBranch}" -o merge_request.create -o merge_request.target="${targetBranch}" -o merge_request.remove_source_branch -o merge_request.title="${title}"`;
		const { exitCode, stdout, stderr } = await execCommand(cmd);
		if (exitCode > 0) throw new Error(`${stdout}\n${stderr}`);

		const url = await new UtilFunctions().processText(stdout, 'Respond only with the URL where the merge request is.');
		if (!URL.canParse(url)) {
			throw new Error(`LLM did not extract MR url. Returned ${url}`);
		}
		return url;
	}

	/**
	 * @returns the diffs for a merge request
	 */
	// @cacheRetry({ scope: 'execution' })
	@span()
	async getMergeRequestDiffs(gitlabProjectId: string | number, mergeRequestIId: number): Promise<string> {
		const diffs: MergeRequestDiffSchema[] = await this.api.MergeRequests.allDiffs(gitlabProjectId, mergeRequestIId, { perPage: 20 });
		let result = '<git-diffs>';

		for (const fileDiff of diffs) {
			if (fileDiff.new_path.endsWith('.ts')) {
				// Strip out the deleted lines in the diff
				// Then remove the + character, so we're
				// left with the current code.
				const diff = fileDiff.diff;
				// .split('\n')
				// .filter((line) => !line.startsWith('-'))
				// .map((line) => (line.startsWith('+') ? line.slice(1) : line))
				// .join('\n');
				result += `<diff path="${fileDiff.new_path}">\n${diff}\n</diff>\n`;
			}
		}
		return result;
	}

	@cacheRetry()
	@span()
	async getDiffs(gitlabProjectId: string | number, mergeRequestIId: number): Promise<MergeRequestDiffSchema[]> {
		return await this.api.MergeRequests.allDiffs(gitlabProjectId, mergeRequestIId, { perPage: 20 });
	}

	@span()
	async reviewMergeRequest(gitlabProjectId: string | number, mergeRequestIId: number): Promise<MergeRequestDiffSchema[]> {
		const mergeRequest: ExpandedMergeRequestSchema = await this.api.MergeRequests.show(gitlabProjectId, mergeRequestIId);
		const diffs: MergeRequestDiffSchema[] = await this.getDiffs(gitlabProjectId, mergeRequestIId);

		const codeReviewConfigs = await loadCodeReviews();

		// Find the code review configurations which are relevant for this diff
		const codeReviews: Promise<DiffReview>[] = [];
		for (const diff of diffs) {
			for (const codeReview of codeReviewConfigs) {
				let hasExtension = false;
				for (const extension of codeReview.file_extensions?.include ?? []) {
					if (diff.new_path.endsWith(extension)) {
						hasExtension = true;
						break;
					}
				}
				if (!hasExtension) continue;
				let hasText = false;
				for (const text of codeReview.requires?.text ?? []) {
					if (diff.diff.includes(text)) {
						hasText = true;
						break;
					}
				}
				if (hasExtension && hasText) {
					codeReviews.push(this.reviewDiff(diff, codeReview));
				}
			}
		}

		let diffReviews = await allSettledAndFulFilled(codeReviews);
		diffReviews = diffReviews.filter((diffReview) => diffReview !== null);

		for (const diffReview of diffReviews) {
			for (const comment of diffReview.comments) {
				logger.debug(comment, 'Review comment');
				const position: MergeRequestDiscussionNotePositionOptions = {
					baseSha: mergeRequest.diff_refs.base_sha,
					headSha: mergeRequest.diff_refs.head_sha,
					startSha: mergeRequest.diff_refs.start_sha,
					newPath: diffReview.mrDiff.new_path,
					positionType: 'text',
					newLine: comment.lineNumber.toString(),
				};

				await this.api.MergeRequestDiscussions.create(gitlabProjectId, mergeRequestIId, comment.comment, { position });
			}
		}
		return diffs;
	}

	/**
	 * Review a diff from a merge request using the code review guidelines configured by the files in resources/codeReview
	 * @param mrDiff
	 * @param codeReview
	 */
	@cacheRetry()
	async reviewDiff(mrDiff: MergeRequestDiffSchema, codeReview: ICodeReview): Promise<DiffReview> {
		// The first line of the diff has the starting line number e.g. @@ -0,0 +1,76 @@
		let startingLineNumber = getStartingLineNumber(mrDiff.diff);

		// Transform the diff, so it's not a diff, removing the deleted lines so only the unchanged and new lines remain
		// i.e. the code in the latest commit
		const diffLines: string[] = mrDiff.diff
			.trim()
			.split('\n')
			.filter((line) => !line.startsWith('-'))
			.map((line) => (line.startsWith('+') ? line.slice(1) : line));
		// diffLines = diffLines.slice(1)
		startingLineNumber -= 1;
		diffLines[0] = `/*${startingLineNumber}*/`;

		// Add lines numbers
		for (let i = 1; i < diffLines.length; i++) {
			const line = diffLines[i];
			// Add the line number on blank lines
			if (!line.trim().length) diffLines[i] = `/*${startingLineNumber + i}*/`;
			// Add in a line number every ten lines
			if (i % 10 === 0) {
				const comment = `/*${startingLineNumber + i}*/`;
				if (!line.slice(0, comment.length).trim().length) {
					diffLines[i] = comment + line.slice(comment.length);
				}
			}
		}
		const currentCode = diffLines.join('\n');

		const prompt = `You are an AI software engineer whose task is to review the code changes for our software development style standards.
		The following is the configuration of the particular code review that you must do.
		${codeReview.xml}
		The code to review is:
		<code>
		${currentCode}
		</code>
		The comments like /*14*/ at the start of lines are the line numbers.
		Response only in JSON wrapped in <json></json>.
		Based on the provided code review guidelines, analyze the code changes and identify any potential invalid code which violates the code review description. 
		If no violations are found, responsd with an empty JSON array i.e. <json>[]</json>
		If violations exist, provide the following information in JSON format:
		(Line is number where the violation occurs (use the new_line number))
		<example>
		<json>
		[{
		  "lineNumber": number,
		  "comment": "Explanation of the violation and suggestion for valid code in Markdown format"
		}]
		</json>
		</example>
		`;
		const reviewComments = (await llms().medium.generateTextAsJson(prompt)) as Array<{ lineNumber: number; comment: string }>;

		return { code: currentCode, comments: reviewComments, mrDiff };
	}
}

export function getStartingLineNumber(diff: string): number {
	diff = diff.slice(diff.indexOf('+'));
	diff = diff.slice(0, diff.indexOf(','));
	return parseInt(diff);
}
