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
 *   trapeze-db-url              (secret text)  — full DATABASE_URL
 *   trapeze-gcs-bucket          (secret text)  — GCS bucket name (no gs:// prefix)
 *   trapeze-gcs-project         (secret text)  — GCP project ID
 *   trapeze-gcs-credentials     (secret file)  — GCP service account JSON key
 *   trapeze-jira-base-url       (secret text)  — Jira base URL
 *   trapeze-jira-email          (secret text)  — Jira service account email
 *   trapeze-jira-api-token      (secret text)  — Jira API token
 *   trapeze-testrail-base-url   (secret text)  — TestRail base URL
 *   trapeze-testrail-email      (secret text)  — TestRail service account email
 *   trapeze-testrail-api-token  (secret text)  — TestRail API token
 *
 * Environment variables consumed (set in docker-compose.yml or exported before
 * running scripts/jenkins-seed-prod.sh):
 *   DATABASE_URL, GCS_BUCKET, GCS_PROJECT, GCS_SA_KEY_PATH (path to JSON file)
 *   JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN
 *   TESTRAIL_BASE_URL, TESTRAIL_EMAIL, TESTRAIL_API_TOKEN
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

// Wait for Jenkins to be fully started before touching credential APIs
def jenkins = Jenkins.instanceOrNull
int waited = 0
while (jenkins == null || !jenkins.isFullyStarted()) {
    if (waited > 60) { println "[02-seed] ERROR: Jenkins did not start within 60 s"; return }
    Thread.sleep(1000)
    waited++
    jenkins = Jenkins.instanceOrNull
}

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
        println "[02-seed] WARNING: file not found or empty at '${filePath}' — skipping '${id}'"
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

jenkins.save()
println "[02-seed] Credential seeding complete."
