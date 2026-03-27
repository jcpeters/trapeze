/**
 * 04-register-shared-library.groovy
 *
 * Registers the Trapeze repo as a Jenkins Global Shared Library named 'trapeze'.
 *
 * Once registered, any pipeline in this Jenkins instance can load the library with:
 *
 *   @Library('trapeze') _
 *
 * and call the steps defined under vars/ in this repo, e.g.:
 *
 *   trapezePushResults(framework: 'playwright', resultFile: '...', environment: 'acceptance')
 *
 * Idempotent: if a library named 'trapeze' is already registered, this script
 * is a no-op.
 *
 * Configuration:
 *   TRAPEZE_REPO_URL — Git URL of the Trapeze repo.
 *                      Default: file:///workspace/trapeze (volume mount, for local dev).
 *                      In production, set to the remote Git URL in docker-compose.yml
 *                      or inject via the jenkins-seed-prod.sh script.
 */

import jenkins.model.*
import org.jenkinsci.plugins.workflow.libs.*
import jenkins.plugins.git.GitSCMSource
import jenkins.plugins.git.traits.BranchDiscoveryTrait

def jenkins = Jenkins.instance

def libName  = 'trapeze'
def repoUrl  = System.getenv('TRAPEZE_REPO_URL') ?: 'file:///workspace/trapeze'

def globalLibs = jenkins.getDescriptor(GlobalLibraries.class)
def existing   = globalLibs.getLibraries()

if (existing.any { it.name == libName }) {
    println "[04-shared-lib] Shared library '${libName}' already registered — skipping"
} else {
    def source = new GitSCMSource(repoUrl)
    source.traits = [new BranchDiscoveryTrait()]

    def retriever = new SCMSourceRetriever(source)
    def lib = new LibraryConfiguration(libName, retriever)
    lib.setDefaultVersion('main')
    lib.setImplicit(false)          // explicit @Library import required (safer)
    lib.setAllowVersionOverride(true)

    globalLibs.setLibraries(existing + [lib])
    jenkins.save()
    println "[04-shared-lib] Registered shared library '${libName}' → ${repoUrl}"
}
