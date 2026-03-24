/**
 * trapezePushResults
 *
 * Jenkins Shared Library step that uploads test results to the Trapeze GCS
 * drop zone.  Add to any pipeline that runs Selenium (pytest/JUnit XML) or
 * Playwright tests.
 *
 * This step is DATABASE-FREE.  It only needs:
 *   - Node.js on the Jenkins agent
 *   - GCS write access via the trapeze-gcs-credentials secret-file credential
 *   - The Trapeze repo checked out somewhere the agent can reach
 *
 * ── Usage in a Playwright pipeline ───────────────────────────────────────────
 *
 *   @Library('trapeze') _
 *
 *   // In the post { always { ... } } block, or in a dedicated stage:
 *   trapezePushResults(
 *       framework:   'playwright',
 *       resultFile:  "${WORKSPACE}/pw-results/shard-1-of-4.json",
 *       environment: 'acceptance',
 *       shardIndex:  1,
 *       shardTotal:  4,
 *       project:     'chromium'
 *   )
 *
 * ── Usage in a Selenium/pytest pipeline ──────────────────────────────────────
 *
 *   @Library('trapeze') _
 *
 *   trapezePushResults(
 *       framework:   'pytest',
 *       resultFile:  "${WORKSPACE}/test-output/junit-results.xml",
 *       environment: 'acceptance'
 *   )
 *
 * ── Required Jenkins credentials ─────────────────────────────────────────────
 *
 *   trapeze-gcs-bucket        Secret text  — GCS bucket name (no gs:// prefix)
 *   trapeze-gcs-project       Secret text  — GCP project ID
 *   trapeze-gcs-credentials   Secret file  — GCP service account JSON key
 *                             (omit if agents use GKE Workload Identity)
 *
 * ── Trapeze repo location ─────────────────────────────────────────────────────
 *
 *   By default this step checks out the Trapeze repo to ${WORKSPACE}/.trapeze-lib
 *   automatically.  Override in order of precedence:
 *     1. Pass trapezeDir: '/path/to/trapeze' in the config map
 *     2. Set TRAPEZE_DIR as a pipeline environment variable
 *     3. (default) Auto-checkout using TRAPEZE_REPO_URL global env var +
 *        github-ssh-key credential
 *
 * ── Parameters ────────────────────────────────────────────────────────────────
 *
 *   framework     (required) 'playwright' | 'pytest' | 'junit'
 *   resultFile    (required) Absolute path to the result file on the agent
 *   environment   (optional) Target environment label, default 'unknown'
 *   suiteName     (optional) Suite name override
 *   shardIndex    (optional) 1-based shard number (null = not sharded)
 *   shardTotal    (optional) Total shard count (required when shardIndex is set)
 *   project       (optional) Playwright project name (e.g. 'chromium', 'acceptance')
 *   artifactsDir  (optional) Path to test-results/ dir; contents uploaded recursively
 *   startedAt     (optional) ISO-8601 build start time (e.g. from `date -u`)
 *   finishedAt    (optional) ISO-8601 build finish time
 *   extraEnv      (optional) Groovy Map of extra metadata stored in CiRun.env JSONB
 *                            (e.g. [nodeVersion: 'v20.11.0', playwrightVersion: '1.42.0'])
 *   trapezeDir    (optional) Path to checked-out Trapeze repo; auto-checkout if omitted
 */

def call(Map config = [:]) {
    // Required
    def framework  = config.framework  ?: error("trapezePushResults: 'framework' is required")
    def resultFile = config.resultFile ?: error("trapezePushResults: 'resultFile' is required")

    // Optional with defaults
    def environment  = config.environment  ?: 'unknown'
    def suiteName    = config.suiteName    ?: ''
    def shardIndex   = config.shardIndex   // null means not sharded
    def shardTotal   = config.shardTotal
    def project      = config.project      ?: ''
    def artifactsDir = config.artifactsDir ?: ''
    def startedAt    = config.startedAt    ?: ''
    def finishedAt   = config.finishedAt   ?: ''
    def extraEnvMap  = config.extraEnv     ?: [:]

    // Resolve Trapeze repo location
    def trapezeDir = config.trapezeDir ?: (env.TRAPEZE_DIR ?: '')

    stage("Trapeze: push results to drop zone") {
        // Check that the result file was actually produced
        if (!fileExists(resultFile)) {
            echo "Trapeze: result file not found at ${resultFile} — skipping drop zone upload."
            return
        }

        // If no explicit trapezeDir, auto-checkout the Trapeze repo
        if (!trapezeDir) {
            trapezeDir = "${WORKSPACE}/.trapeze-lib"
            def repoUrl = env.TRAPEZE_REPO_URL
            if (!repoUrl) {
                error("trapezePushResults: TRAPEZE_REPO_URL is not set and trapezeDir was not provided. " +
                      "Set the TRAPEZE_REPO_URL global env var in Manage Jenkins → System, or pass trapezeDir in config.")
            }
            dir(trapezeDir) {
                checkout([
                    $class: 'GitSCM',
                    branches: [[name: '*/main']],
                    userRemoteConfigs: [[
                        url: repoUrl,
                        credentialsId: 'github-ssh-key'
                    ]]
                ])
                sh 'npm ci --prefer-offline'
            }
        }

        withCredentials([
            string(credentialsId: 'trapeze-gcs-bucket',  variable: 'GCS_BUCKET'),
            string(credentialsId: 'trapeze-gcs-project', variable: 'GCS_PROJECT'),
            // Remove the next line if your agents use GKE Workload Identity
            file(credentialsId: 'trapeze-gcs-credentials', variable: 'GOOGLE_APPLICATION_CREDENTIALS'),
        ]) {
            dir(trapezeDir) {
                def cmd = [
                    "node_modules/.bin/tsx",
                    "./scripts/upload-to-drop-zone.ts",
                    "--file",        resultFile,
                    "--job",         env.JOB_NAME,
                    "--build",       env.BUILD_NUMBER,
                    "--framework",   framework,
                    "--branch",      (env.GIT_BRANCH ?: env.BRANCH_NAME ?: 'unknown'),
                    "--git-sha",     (env.GIT_COMMIT ?: 'unknown'),
                    "--build-url",   env.BUILD_URL,
                    "--environment", environment,
                    "--ci-provider", "jenkins",
                ]

                if (suiteName) {
                    cmd += ["--suite-name", suiteName]
                }
                if (shardIndex != null) {
                    cmd += ["--shard-index", shardIndex.toString(),
                            "--shard-total", shardTotal.toString()]
                }
                if (project) {
                    cmd += ["--project", project]
                }
                if (artifactsDir && fileExists(artifactsDir)) {
                    cmd += ["--artifacts-dir", artifactsDir]
                }
                if (startedAt) {
                    cmd += ["--started-at", startedAt]
                }
                if (finishedAt) {
                    cmd += ["--finished-at", finishedAt]
                }
                if (extraEnvMap) {
                    def extraEnvJson = groovy.json.JsonOutput.toJson(extraEnvMap)
                    cmd += ["--extra-env", "'${extraEnvJson}'"]
                }

                sh cmd.join(" ")
            }
        }
    }
}
