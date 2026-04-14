/**
 * 02-seed-credentials.groovy
 *
 * Auto-creates all Trapeze Jenkins credentials on first boot by reading values
 * from environment variables injected by docker-compose.yml (and its env_file).
 *
 * Idempotent: any credential whose ID already exists is skipped, so re-running
 * this script (e.g. after a Jenkins restart) is safe.
 *
 * Credentials created:
 *   trapeze-db-url                        (secret text)          — full DATABASE_URL
 *   trapeze-gcs-bucket                    (secret text)          — GCS bucket name
 *   trapeze-gcs-project                   (secret text)          — GCP project ID
 *   trapeze-gcs-credentials               (secret file)          — GCP service account JSON key
 *   trapeze-jira-base-url                 (secret text)          — Jira base URL
 *   trapeze-jira-email                    (secret text)          — Jira service account email
 *   trapeze-jira-api-token                (secret text)          — Jira API token
 *   trapeze-testrail-base-url             (secret text)          — TestRail base URL
 *   trapeze-testrail-email                (secret text)          — TestRail service account email
 *   trapeze-testrail-api-token            (secret text)          — TestRail API token
 *   github-token                          (username + password)  — GitHub PAT for HTTPS git checkout
 *   github-ssh-key                        (username + password)  — Alias for github-token; required by playwright_pipeline.groovy prod
 *   TEST_INTEL_DATABASE_URL               (secret text)          — DB URL for playwright_pipeline.groovy ingest step (= DATABASE_URL)
 *   trapeze-slack-webhook-url             (secret text)          — Slack Incoming Webhook for CI alerts
 *   SLACK_VERSION_AUTOMATION_WORKFLOW_URL (secret text)          — Slack workflow webhook (playwright-acceptance)
 *
 * Environment variables consumed (set in docker-compose.yml or .env):
 *   DATABASE_URL, GCS_BUCKET, GCS_PROJECT, GCS_SA_KEY_PATH (path to JSON file)
 *   JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN
 *   TESTRAIL_BASE_URL, TESTRAIL_EMAIL, TESTRAIL_API_TOKEN
 *   GITHUB_USERNAME (default: git), GITHUB_TOKEN — Personal Access Token with repo scope
 *   SLACK_TRAPEZE_WEBHOOK_URL — Slack Incoming Webhook URL for #qa-alerts (or similar)
 *   SLACK_VERSION_AUTOMATION_WORKFLOW_URL — Slack workflow webhook for playwright-acceptance
 *
 * In production, remove GCS_SA_KEY_PATH and trapeze-gcs-credentials if your
 * Jenkins agents use GKE Workload Identity — no SA key file is needed.
 */

import jenkins.model.*
import com.cloudbees.plugins.credentials.*
import com.cloudbees.plugins.credentials.domains.*
import com.cloudbees.plugins.credentials.impl.*
import org.jenkinsci.plugins.plaincredentials.impl.*
import hudson.util.Secret
import org.jenkinsci.plugins.plaincredentials.impl.StringCredentialsImpl

// Wait for Jenkins to be fully started before touching credential APIs
def jenkins = Jenkins.instance

def store  = jenkins.getExtensionList('com.cloudbees.plugins.credentials.SystemCredentialsProvider')[0].getStore()
def domain = Domain.global()

// ── Helpers ───────────────────────────────────────────────────────────────────

def credExists = { id ->
    store.getCredentials(domain).any { it.id == id }
}

def addSecretText = { id, value, desc ->
    if (credExists(id)) {
        println "[02-seed] Credential '${id}' already exists — skipping"
        return
    }
    if (!value) {
        println "[02-seed] WARNING: env var for '${id}' is not set — skipping"
        return
    }
    store.addCredentials(domain,
        new StringCredentialsImpl(CredentialsScope.GLOBAL, id, desc, Secret.fromString(value)))
    println "[02-seed] Created secret-text credential: ${id}"
}

def addUserPass = { id, username, password, desc ->
    if (credExists(id)) {
        println "[02-seed] Credential '${id}' already exists — skipping"
        return
    }
    if (!password) {
        println "[02-seed] WARNING: password/token for '${id}' is not set — skipping"
        return
    }
    store.addCredentials(domain,
        new UsernamePasswordCredentialsImpl(CredentialsScope.GLOBAL, id, desc,
            username ?: 'git', password))
    println "[02-seed] Created username+password credential: ${id}"
}

def addSecretFile = { id, filePath, desc ->
    if (credExists(id)) {
        println "[02-seed] Credential '${id}' already exists — skipping"
        return
    }
    if (!filePath) {
        println "[02-seed] WARNING: GCS_SA_KEY_PATH is not set — skipping '${id}'"
        return
    }
    def f = new File(filePath)
    if (!f.exists() || f.length() == 0) {
        // No real SA key present (local dev with fake-gcs emulator).
        // Seed a placeholder JSON so pipeline withCredentials() blocks don't
        // fail credential lookup. fake-gcs ignores credentials entirely.
        def placeholder = '{"type":"service_account","project_id":"local-dev-placeholder"}'.bytes
        store.addCredentials(domain,
            new FileCredentialsImpl(CredentialsScope.GLOBAL, id, desc + ' [DEV PLACEHOLDER]',
                'gcs-sa-key.json',
                com.cloudbees.plugins.credentials.SecretBytes.fromBytes(placeholder)))
        println "[02-seed] Created placeholder secret-file credential: ${id} (no SA key file found at ${filePath})"
        return
    }
    def bytes    = f.bytes
    def fileName = f.name
    store.addCredentials(domain,
        new FileCredentialsImpl(CredentialsScope.GLOBAL, id, desc, fileName,
            com.cloudbees.plugins.credentials.SecretBytes.fromBytes(bytes)))
    println "[02-seed] Created secret-file credential: ${id} (${fileName}, ${bytes.length} bytes)"
}

// ── Secret-text credentials ───────────────────────────────────────────────────

addSecretText('trapeze-db-url',             System.getenv('DATABASE_URL'),      'Trapeze: Postgres DATABASE_URL')
addSecretText('trapeze-gcs-bucket',         System.getenv('GCS_BUCKET'),        'Trapeze: GCS bucket name')
addSecretText('trapeze-gcs-project',        System.getenv('GCS_PROJECT'),       'Trapeze: GCS project ID')
addSecretText('trapeze-jira-base-url',      System.getenv('JIRA_BASE_URL'),     'Trapeze: Jira base URL')
addSecretText('trapeze-jira-email',         System.getenv('JIRA_EMAIL'),        'Trapeze: Jira service account email')
addSecretText('trapeze-jira-api-token',     System.getenv('JIRA_API_TOKEN'),    'Trapeze: Jira API token')
addSecretText('trapeze-testrail-base-url',  System.getenv('TESTRAIL_BASE_URL'), 'Trapeze: TestRail base URL')
addSecretText('trapeze-testrail-email',     System.getenv('TESTRAIL_EMAIL'),    'Trapeze: TestRail service account email')
addSecretText('trapeze-testrail-api-token', System.getenv('TESTRAIL_API_TOKEN'),'Trapeze: TestRail API token')

// ── Secret-file credential (GCS service account JSON key) ─────────────────────

addSecretFile('trapeze-gcs-credentials', System.getenv('GCS_SA_KEY_PATH'), 'Trapeze: GCS service account JSON key')

// ── GitHub credential (username + Personal Access Token for HTTPS git checkout)
// Used by all pipeline jobs that check out from github.com instead of file://.
// Requires repo scope on the PAT. A single PAT can access both jcpeters/trapeze
// and evite/qa as long as the account has access to both.
// Set in .env:
//   GITHUB_USERNAME=jcpeters
//   GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
//   TRAPEZE_REPO_URL=https://github.com/jcpeters/trapeze.git
//   EVITE_PLAYWRIGHT_REPO_URL=https://github.com/evite/qa.git

addUserPass('github-token',
    System.getenv('GITHUB_USERNAME') ?: 'git',
    System.getenv('GITHUB_TOKEN'),
    'GitHub Personal Access Token — HTTPS git checkout (repo scope)')

// 'github-ssh-key' is referenced by playwright_pipeline.groovy (evite/qa prod branch)
// for the results repo checkout. In local dev the repo URL is file:// so the credential
// value is not used, but Jenkins requires the ID to exist in the store.
// Seeds the same PAT as username+password; swap for a real SSH key in production.
def ghToken  = System.getenv('GITHUB_TOKEN')
def ghUser   = System.getenv('GITHUB_USERNAME') ?: 'git'
if (!credExists('github-ssh-key')) {
    def sshPassword = ghToken ?: 'local-dev-placeholder'
    store.addCredentials(domain,
        new UsernamePasswordCredentialsImpl(CredentialsScope.GLOBAL, 'github-ssh-key',
            'GitHub SSH key (username+PAT alias for local dev; replace with real SSH key in prod)',
            ghUser, sshPassword))
    def note = ghToken ? '' : ' [DEV PLACEHOLDER]'
    println "[02-seed] Created credential: github-ssh-key${note}"
} else {
    println "[02-seed] Credential 'github-ssh-key' already exists — skipping"
}

// TEST_INTEL_DATABASE_URL — used by playwright_pipeline.groovy (evite/qa prod) inside
// withCredentials() to inject DATABASE_URL for the etl:ingest:playwright step.
// Maps to the same Postgres instance as trapeze-db-url.
addSecretText('TEST_INTEL_DATABASE_URL',
    System.getenv('DATABASE_URL'),
    'Test Intelligence DB URL — injected as DATABASE_URL by playwright_pipeline.groovy ingest step')

// ── Slack credentials ──────────────────────────────────────────────────────────

// Incoming Webhook URL for CI job alerts (failure/success on ETL + test jobs).
// Set SLACK_TRAPEZE_WEBHOOK_URL in .env to a Slack Incoming Webhook URL.
// Create one at: https://api.slack.com/apps → your app → Incoming Webhooks
addSecretText('trapeze-slack-webhook-url',
    System.getenv('SLACK_TRAPEZE_WEBHOOK_URL'),
    'Trapeze: Slack Incoming Webhook URL for CI build notifications')

// Slack Workflow webhook used by playwright-acceptance (playwright_pipeline.groovy).
// A placeholder is seeded when the real URL is not configured so the pipeline's
// try/catch doesn't fail on credential lookup.
def slackWorkflowUrl = System.getenv('SLACK_VERSION_AUTOMATION_WORKFLOW_URL') ?: 'https://hooks.slack.com/placeholder'
if (!credExists('SLACK_VERSION_AUTOMATION_WORKFLOW_URL')) {
    store.addCredentials(domain,
        new StringCredentialsImpl(CredentialsScope.GLOBAL,
            'SLACK_VERSION_AUTOMATION_WORKFLOW_URL',
            'Slack Version Automation Workflow URL (playwright-acceptance)',
            Secret.fromString(slackWorkflowUrl)))
    def note = slackWorkflowUrl.contains('placeholder') ? ' [DEV PLACEHOLDER]' : ''
    println "[02-seed] Created secret-text credential: SLACK_VERSION_AUTOMATION_WORKFLOW_URL${note}"
} else {
    println "[02-seed] Credential 'SLACK_VERSION_AUTOMATION_WORKFLOW_URL' already exists — skipping"
}

jenkins.save()
println "[02-seed] Credential seeding complete."
