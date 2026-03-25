"""
test_smoke.py — Evite Selenium smoke tests.

Two test cases that prove the full Trapeze pipeline is wired correctly:
  CI run → JUnit XML → GCS drop zone → ingest-junit.ts → Postgres → Metabase

Class and method names intentionally mirror the demo JUnit fixture
(junit_xml/demo/login-build-3001.xml) so that flake detection can correlate
real test runs against historical demo data:
  classname: test_evite_login.TestEviteLogin  → test_valid_login
  classname: test_evite_rsvp.TestEviteRSVP   → test_rsvp_yes_flow

Replace or extend these tests with your full Selenium acceptance suite.
"""

import pytest
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC


class TestEviteLogin:
    """
    Mirrors classname: test_evite_login.TestEviteLogin from the demo fixture.
    """

    def test_valid_login(self, driver, base_url):
        """Navigate to the homepage and verify the page loads with a title."""
        driver.get(base_url)
        WebDriverWait(driver, 15).until(
            EC.presence_of_element_located((By.TAG_NAME, "body"))
        )
        assert driver.title, (
            f"Page title was empty after navigating to {base_url}. "
            "This likely means the page did not load."
        )


class TestEviteRSVP:
    """
    Mirrors classname: test_evite_rsvp.TestEviteRSVP from the demo fixture.
    """

    def test_rsvp_yes_flow(self, driver, base_url):
        """Navigate to /rsvp and verify the page responds (redirects are acceptable)."""
        driver.get(f"{base_url}/rsvp")
        WebDriverWait(driver, 15).until(
            EC.presence_of_element_located((By.TAG_NAME, "body"))
        )
        assert driver.current_url, (
            f"No URL resolved after navigating to {base_url}/rsvp"
        )
