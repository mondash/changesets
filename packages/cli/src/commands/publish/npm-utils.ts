import { ExitError } from "@changesets/errors";
import { error, info, warn } from "@changesets/logger";
import { PackageJSON } from "@changesets/types";
import pLimit from "p-limit";
import preferredPM from "preferred-pm";
import chalk from "chalk";
import spawn from "spawndamnit";
import semver from "semver";
import { askQuestion } from "../../utils/cli-utilities";
import isCI from "../../utils/isCI";
import { TwoFactorState } from "../../utils/types";

const npmRequestLimit = pLimit(40);
const npmPublishLimit = pLimit(10);

function jsonParse(input: string) {
  try {
    return JSON.parse(input);
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.error("error parsing json:", input);
    }
    throw err;
  }
}

function getCorrectRegistry(packageJson?: PackageJSON): string {
  const registry =
    packageJson?.publishConfig?.registry ?? process.env.npm_config_registry;

  return !registry || registry === "https://registry.yarnpkg.com"
    ? "https://registry.npmjs.org"
    : registry;
}

type PublishTool =
  | { name: "npm" }
  | { name: "pnpm"; shouldAddNoGitChecks: boolean }
  | { name: "yarn"; berry: boolean };

async function getPublishTool(cwd: string): Promise<PublishTool> {
  const pm = await preferredPM(cwd);

  if (pm?.name === "pnpm") {
    try {
      const result = await spawn("pnpm", ["--version"], { cwd });
      const version = result.stdout.toString().trim();
      const parsed = semver.parse(version);
      return {
        name: "pnpm",
        shouldAddNoGitChecks:
          parsed?.major === undefined ? false : parsed.major >= 5
      };
    } catch (e) {
      return {
        name: "pnpm",
        shouldAddNoGitChecks: false
      };
    }
  }

  if (pm?.name === "yarn") {
    try {
      const result = await spawn("yarn", ["--version"], { cwd });
      const version = result.stdout.toString().trim();
      const parsed = semver.parse(version);

      return {
        name: "yarn",
        berry: parsed?.major === undefined ? false : parsed.major >= 2
      };
    } catch (error) {
      return {
        name: "yarn",
        berry: false
      };
    }
  }

  return { name: "npm" };
}

export async function getTokenIsRequired() {
  // Due to a super annoying issue in yarn, we have to manually override this env variable
  // See: https://github.com/yarnpkg/yarn/issues/2935#issuecomment-355292633
  const envOverride = {
    npm_config_registry: getCorrectRegistry()
  };
  let result = await spawn("npm", ["profile", "get", "--json"], {
    env: Object.assign({}, process.env, envOverride)
  });
  let json = jsonParse(result.stdout.toString());
  if (json.error || !json.tfa || !json.tfa.mode) {
    return false;
  }
  return json.tfa.mode === "auth-and-writes";
}

export function getPackageInfo(packageJson: PackageJSON) {
  return npmRequestLimit(async () => {
    info(`npm info ${packageJson.name}`);

    // Due to a couple of issues with yarnpkg, we also want to override the npm registry when doing
    // npm info.
    // Issues: We sometimes get back cached responses, i.e old data about packages which causes
    // `publish` to behave incorrectly. It can also cause issues when publishing private packages
    // as they will always give a 404, which will tell `publish` to always try to publish.
    // See: https://github.com/yarnpkg/yarn/issues/2935#issuecomment-355292633
    let result = await spawn("npm", [
      "info",
      packageJson.name,
      "--registry",
      getCorrectRegistry(packageJson),
      "--json"
    ]);

    // Github package registry returns empty string when calling npm info
    // for a non-existant package instead of a E404
    if (result.stdout.toString() === "") {
      return {
        error: {
          code: "E404"
        }
      };
    }
    return jsonParse(result.stdout.toString());
  });
}

export async function infoAllow404(packageJson: PackageJSON) {
  let pkgInfo = await getPackageInfo(packageJson);
  if (pkgInfo.error?.code === "E404") {
    warn(`Received 404 for npm info ${chalk.cyan(`"${packageJson.name}"`)}`);
    return { published: false, pkgInfo: {} };
  }
  if (pkgInfo.error) {
    error(
      `Received an unknown error code: ${
        pkgInfo.error.code
      } for npm info ${chalk.cyan(`"${packageJson.name}"`)}`
    );
    error(pkgInfo.error.summary);
    if (pkgInfo.error.detail) error(pkgInfo.error.detail);

    throw new ExitError(1);
  }
  return { published: true, pkgInfo };
}

let otpAskLimit = pLimit(1);

let askForOtpCode = (twoFactorState: TwoFactorState) =>
  otpAskLimit(async () => {
    if (twoFactorState.token !== null) return twoFactorState.token;
    info(
      "This operation requires a one-time password from your authenticator."
    );

    let val = await askQuestion("Enter one-time password:");
    twoFactorState.token = val;
    return val;
  });

export let getOtpCode = async (twoFactorState: TwoFactorState) => {
  if (twoFactorState.token !== null) {
    return twoFactorState.token;
  }
  return askForOtpCode(twoFactorState);
};

// we have this so that we can do try a publish again after a publish without
// the call being wrapped in the npm request limit and causing the publishes to potentially never run
async function internalPublish(
  pkgName: string,
  opts: { cwd: string; access?: string; tag: string },
  twoFactorState: TwoFactorState
): Promise<{ published: boolean }> {
  const publishTool = await getPublishTool(opts.cwd);
  const publishArgs: string[] = [];

  if (publishTool.name === "yarn" && publishTool.berry) {
    publishArgs.push("npm");
  }
  publishArgs.push("publish", opts.cwd, "--json");

  if (opts.access) {
    publishArgs.push("--access", opts.access);
  }

  publishArgs.push("--tag", opts.tag);

  if ((await twoFactorState.isRequired) && !isCI) {
    const otpCode = await getOtpCode(twoFactorState);
    publishArgs.push("--otp", otpCode);
  }

  if (publishTool.name === "pnpm" && publishTool.shouldAddNoGitChecks) {
    publishArgs.push("--no-git-checks");
  }

  // Due to a super annoying issue in yarn, we have to manually override this env variable
  // See: https://github.com/yarnpkg/yarn/issues/2935#issuecomment-355292633
  const envOverride = {
    npm_config_registry: getCorrectRegistry()
  };
  const { stdout } = await spawn(publishTool.name, publishArgs, {
    env: Object.assign({}, process.env, envOverride)
  });
  // New error handling. NPM's --json option is included alongside the `prepublish and
  // `postpublish` contents in terminal. We want to handle this as best we can but it has
  // some struggles
  // Note that both pre and post publish hooks are printed before the json out, so this works.
  const json = jsonParse(stdout.toString().replace(/[^{]*/, ""));

  if (!json.error) return { published: true };

  // The first case is no 2fa provided, the second is when the 2fa is wrong (timeout or wrong words)
  if (
    (json.error.code === "EOTP" ||
      (json.error.code === "E401" &&
        json.error.detail.includes("--otp=<code>"))) &&
    !isCI
  ) {
    if (twoFactorState.token !== null) {
      // the current otp code must be invalid since it errored
      twoFactorState.token = null;
    }
    // just in case this isn't already true
    twoFactorState.isRequired = Promise.resolve(true);
    return internalPublish(pkgName, opts, twoFactorState);
  }
  error(
    `an error occurred while publishing ${pkgName}: ${json.error.code}`,
    json.error.summary,
    json.error.detail ? "\n" + json.error.detail : ""
  );
  return { published: false };
}

export function publish(
  pkgName: string,
  opts: { cwd: string; access?: string; tag: string },
  twoFactorState: TwoFactorState
): Promise<{ published: boolean }> {
  // If there are many packages to be published, it's better to limit the
  // concurrency to avoid unwanted errors, for example from npm.
  return npmRequestLimit(() =>
    npmPublishLimit(() => internalPublish(pkgName, opts, twoFactorState))
  );
}
