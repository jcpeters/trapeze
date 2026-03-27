"""
conftest.py — pytest fixtures for Selenium remote WebDriver tests.

Connects to a Selenium Grid hub (seleniarm/standalone-chromium in docker-compose).
The hub URL is resolved in this order:
  1. --hub CLI flag  (e.g. pytest --hub=http://localhost:4444/wd/hub)
  2. SELENIUM_HUB_URL env var
  3. Default: http://selenium:4444/wd/hub  (Docker service name, works inside Jenkins container)
"""
import os
import pytest
from selenium import webdriver


def pytest_addoption(parser):
    parser.addoption(
        "--hub",
        default=os.environ.get("SELENIUM_HUB_URL", "http://selenium:4444/wd/hub"),
        help="Selenium Grid hub URL (default: http://selenium:4444/wd/hub)",
    )


@pytest.fixture(scope="session")
def base_url():
    """Base URL for the site under test. Set via BASE_URL env var."""
    return os.environ.get("BASE_URL", "https://www.evite.com")


@pytest.fixture
def driver(request):
    """
    Remote Chromium WebDriver connected to the Selenium Grid.

    Yields the driver for use in tests and quits it after the test completes.
    Each test gets a fresh browser session.
    """
    hub_url = request.config.getoption("--hub")
    options = webdriver.ChromeOptions()
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--window-size=1920,1080")
    # Disable GPU rendering in headless Chrome (reduces noise in container logs)
    options.add_argument("--disable-gpu")

    d = webdriver.Remote(command_executor=hub_url, options=options)
    d.implicitly_wait(10)
    yield d
    d.quit()
