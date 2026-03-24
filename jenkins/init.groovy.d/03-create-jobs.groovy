/**
 * 03-create-jobs.groovy
 *
 * Auto-creates all 5 Trapeze scheduled pipeline jobs on first boot.
 *
 * Idempotent: any job that already exists by name is skipped.
 *
 * Also labels the built-in (master) node as 'trapeze automation' so both the
 * scheduled Trapeze jobs and the Playwright acceptance pipeline can run locally
 * without a separate agent. Remove these labels in production and provision
 * dedicated agents labelled 'trapeze' and 'automation' instead.
 *
 * SCM strategy:
 *   - LOCAL Docker dev: Trapeze jobs use file:///workspace/trapeze (volume-mounted repo).
 *     playwright-acceptance uses file:///workspace/evite-playwright.
 *     No SSH credential required for file:// URLs.
 *   - Production: use remote Git URLs in TRAPEZE_REPO_URL / EVITE_PLAYWRIGHT_REPO_URL
 *     with the 'github-ssh-key' credential for private repos.
 *
 * Jobs created:
 *   trapeze-sync-jira           jenkins/Jenkinsfile.sync-jira           H 6 * * *
 *   trapeze-sync-testrail       jenkins/Jenkinsfile.sync-testrail       H 6 * * *
 *   trapeze-snapshot-coverage   jenkins/Jenkinsfile.snapshot-coverage   H 7 * * *
 *   trapeze-analyze-flakes      jenkins/Jenkinsfile.analyze-flakes      H 8 * * 1
 *   trapeze-ingest-from-gcs     jenkins/Jenkinsfile.ingest-from-gcs     H/15 * * * *
 *   playwright-acceptance       scripts/playwright_pipeline.groovy      (on-demand)
 */

import jenkins.model.*
import org.jenkinsci.plugins.workflow.job.*
import org.jenkinsci.plugins.workflow.cps.*
import hudson.plugins.git.*
import hudson.plugins.git.extensions.*
import hudson.triggers.*
import hudson.tasks.*

// Wait for Jenkins to be fully started
def jenkins = Jenkins.instanceOrNull
int waited = 0
while (jenkins == null || !jenkins.isFullyStarted()) {
    if (waited > 60) { println "[03-create-jobs] ERROR: Jenkins did not start within 60 s"; return }
    Thread.sleep(1000)
    waited++
    jenkins = Jenkins.instanceOrNull
}

// ── Label the built-in node as 'trapeze automation' for local dev ─────────────
// 'trapeze'    — used by the scheduled ETL jobs (agent { label 'trapeze' })
// 'automation' — used by the Playwright acceptance pipeline (agent { label 'automation' })
// In production, remove this and use real agents with the appropriate labels.
def requiredLabels = ['trapeze', 'automation'] as Set
def currentLabels  = (jenkins.getLabelString() ?: '').tokenize() as Set
def missing        = requiredLabels - currentLabels
if (missing) {
    def newLabels = (currentLabels + missing).join(' ')
    jenkins.setLabelString(newLabels)
    println "[03-create-jobs] Updated built-in node labels to: ${newLabels}"
}

// ── Resolve repo URLs ─────────────────────────────────────────────────────────
// Default to the volume-mounted repo paths so local dev works without SSH.
def trapezeRepoUrl       = System.getenv('TRAPEZE_REPO_URL')        ?: 'file:///workspace/trapeze'
def evitePlaywrightRepoUrl = System.getenv('EVITE_PLAYWRIGHT_REPO_URL') ?: 'file:///workspace/evite-playwright'

println "[03-create-jobs] Trapeze repo URL:        ${trapezeRepoUrl}"
println "[03-create-jobs] evite-playwright repo URL: ${evitePlaywrightRepoUrl}"

// ── Job definitions ───────────────────────────────────────────────────────────

def jobs = [
    [
        name:       'trapeze-sync-jira',
        scriptPath: 'jenkins/Jenkinsfile.sync-jira',
        cron:       'H 6 * * *',
        concurrent: false,
        description: 'Nightly Jira issue sync (~6 AM). Upserts all issues from JIRA_PROJECTS into jira_issue table.',
    ],
    [
        name:       'trapeze-sync-testrail',
        scriptPath: 'jenkins/Jenkinsfile.sync-testrail',
        cron:       'H 6 * * *',
        concurrent: false,
        description: 'Nightly TestRail sync (~6 AM). Fetches test cases and run results.',
    ],
    [
        name:       'trapeze-snapshot-coverage',
        scriptPath: 'jenkins/Jenkinsfile.snapshot-coverage',
        cron:       'H 7 * * *',
        concurrent: false,
        description: 'Nightly coverage KPI snapshot (~7 AM, after Jira+TestRail syncs). Writes one row to coverage_snapshot.',
    ],
    [
        name:       'trapeze-analyze-flakes',
        scriptPath: 'jenkins/Jenkinsfile.analyze-flakes',
        cron:       'H 8 * * 1',
        concurrent: false,
        description: 'Weekly flake detection (Monday ~8 AM). Scores tests via rolling-window analysis and writes flake_decision rows.',
    ],
    [
        name:       'trapeze-ingest-from-gcs',
        scriptPath: 'jenkins/Jenkinsfile.ingest-from-gcs',
        cron:       'H/15 * * * *',
        concurrent: true,  // explicit in Jenkinsfile; drain jobs can safely overlap
        description: 'GCS drop zone drainer (every 15 min). Downloads manifests from incoming/**, ingests results, archives to processed/**.',
    ],
    [
        name:       'playwright-acceptance',
        scriptPath: 'scripts/playwright_pipeline.groovy',
        repoUrl:    evitePlaywrightRepoUrl,
        cron:       '',           // on-demand only — triggered manually or by other pipelines
        concurrent: false,
        description: 'Playwright acceptance tests → Trapeze GCS drop zone. Trigger manually or via upstream pipeline.',
    ],
]

jobs.each { cfg ->
    if (jenkins.getItem(cfg.name)) {
        println "[03-create-jobs] Job '${cfg.name}' already exists — skipping"
        return
    }

    def job = jenkins.createProject(WorkflowJob, cfg.name)
    job.setDescription(cfg.description)

    // Resolve repo URL for this job (per-job override or fall back to Trapeze repo)
    def jobRepoUrl = cfg.repoUrl ?: trapezeRepoUrl
    def credId     = jobRepoUrl.startsWith('file://') ? '' : 'github-ssh-key'

    // Pipeline from SCM
    def userRemoteConfig = new UserRemoteConfig(jobRepoUrl, null, null, credId ?: null)
    def scm = new GitSCM(
        [userRemoteConfig],
        [new BranchSpec('*/main')],
        false,
        [],
        null,
        null,
        []
    )
    def definition = new CpsScmFlowDefinition(scm, cfg.scriptPath)
    definition.setLightweight(true)
    job.setDefinition(definition)

    // Cron trigger (belt-and-suspenders alongside the triggers{} block in each Jenkinsfile)
    if (cfg.cron) {
        job.addTrigger(new TimerTrigger(cfg.cron))
    }

    // Concurrency
    job.setConcurrentBuild(cfg.concurrent)

    // Build retention
    job.setBuildDiscarder(new LogRotator(-1, 30, -1, -1))

    job.save()
    def cronNote = cfg.cron ? "(cron: '${cfg.cron}')" : "(on-demand)"
    println "[03-create-jobs] Created job: '${cfg.name}' ${cronNote}"
}

jenkins.save()
println "[03-create-jobs] Job creation complete."
