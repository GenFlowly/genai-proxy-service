import requests
from bs4 import BeautifulSoup
import re
import json
import sys
from typing import Optional


def fetch_pricing_data() -> dict:
    """
    Fetch and parse pricing data from the OpenAI pricing page.
    Returns a dictionary mapping model names to their pricing info.
    """
    url = "https://platform.openai.com/docs/pricing"

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
    }

    response = requests.get(url, headers=headers)
    response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")

    pricing = {}

    # OpenAI pricing page uses tables to display pricing
    tables = soup.find_all("table")

    for table in tables:
        # Try to find the section/category heading before this table
        category = ""
        prev = table.find_previous(["h1", "h2", "h3", "h4", "h5"])
        if prev:
            category = prev.get_text(strip=True)

        # Parse table headers
        headers_row = table.find("thead")
        col_headers = []
        if headers_row:
            for th in headers_row.find_all(["th", "td"]):
                col_headers.append(th.get_text(strip=True))

        # Parse table rows
        tbody = table.find("tbody")
        if tbody:
            rows = tbody.find_all("tr")
        else:
            rows = table.find_all("tr")[1:]  # skip header row

        for row in rows:
            cells = row.find_all(["td", "th"])
            if not cells:
                continue

            cell_texts = [cell.get_text(strip=True) for cell in cells]

            if len(cell_texts) < 2:
                continue

            model_name = cell_texts[0].lower().strip()

            # Build pricing info dict from remaining columns
            price_info = {"category": category}
            for i, val in enumerate(cell_texts[1:], 1):
                if i < len(col_headers):
                    price_info[col_headers[i]] = val
                else:
                    price_info[f"col_{i}"] = val

            pricing[model_name] = price_info

    return pricing


def get_model_price(model_name: str, pricing_data: Optional[dict] = None) -> Optional[dict]:
    """
    Look up pricing for a specific model.
    Supports exact match and partial/fuzzy matching.
    """
    if pricing_data is None:
        pricing_data = fetch_pricing_data()

    model_name_lower = model_name.lower().strip()

    # 1. Exact match
    if model_name_lower in pricing_data:
        return {
            "model": model_name,
            "pricing": pricing_data[model_name_lower],
        }

    # 2. Partial match (model name is contained in a key or vice versa)
    partial_matches = {}
    for key, value in pricing_data.items():
        if model_name_lower in key or key in model_name_lower:
            partial_matches[key] = value

    if partial_matches:
        return {
            "model": model_name,
            "matches": partial_matches,
        }

    return None


def list_all_models(pricing_data: Optional[dict] = None):
    """List all available models from the pricing page."""
    if pricing_data is None:
        pricing_data = fetch_pricing_data()

    print(f"\n{'='*60}")
    print(f"Found {len(pricing_data)} model entries:")
    print(f"{'='*60}")

    # Group by category
    categories = {}
    for model, info in pricing_data.items():
        cat = info.get("category", "Unknown")
        if cat not in categories:
            categories[cat] = []
        categories[cat].append((model, info))

    for cat, models in categories.items():
        print(f"\n--- {cat} ---")
        for model, info in models:
            # Print model and pricing columns
            price_cols = {k: v for k, v in info.items() if k != "category"}
            price_str = " | ".join(f"{k}: {v}" for k, v in price_cols.items())
            print(f"  {model:<35} {price_str}")


def main():
    print("Fetching pricing data from OpenAI...")

    try:
        pricing_data = fetch_pricing_data()
    except requests.RequestException as e:
        print(f"Error fetching pricing page: {e}")
        print("\nNote: The OpenAI pricing page may use JavaScript rendering.")
        print("If this fails, consider using the alternative Selenium-based approach below.")
        sys.exit(1)

    if not pricing_data:
        print("No pricing data found. The page structure may have changed,")
        print("or the page requires JavaScript to render.")
        print("\nTrying alternative approach with Selenium...")
        try:
            pricing_data = fetch_pricing_with_selenium()
        except Exception as e:
            print(f"Selenium approach also failed: {e}")
            sys.exit(1)

    print(f"Successfully loaded pricing for {len(pricing_data)} models.\n")

    if len(sys.argv) > 1:
        model_name = " ".join(sys.argv[1:])
        result = get_model_price(model_name, pricing_data)
        if result:
            print(json.dumps(result, indent=2))
        else:
            print(f"Model '{model_name}' not found.")
            print("Use --list to see all available models.")
    else:
        # Interactive mode
        while True:
            print("-" * 40)
            user_input = input("Enter model name (or 'list' / 'quit'): ").strip()

            if user_input.lower() in ("quit", "exit", "q"):
                break

            if user_input.lower() in ("list", "ls", "all"):
                list_all_models(pricing_data)
                continue

            if not user_input:
                continue

            result = get_model_price(user_input, pricing_data)

            if result:
                print(json.dumps(result, indent=2))
            else:
                print(f"\n❌ Model '{user_input}' not found in pricing data.")
                print("Type 'list' to see all available models.\n")


def fetch_pricing_with_selenium() -> dict:
    """
    Alternative: Use Selenium for JS-rendered pages.
    Requires: pip install selenium webdriver-manager
    """
    from selenium import webdriver
    from selenium.webdriver.chrome.service import Service
    from selenium.webdriver.chrome.options import Options
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC

    try:
        from webdriver_manager.chrome import ChromeDriverManager
    except ImportError:
        print("Install webdriver-manager: pip install webdriver-manager")
        raise

    options = Options()
    options.add_argument("--headless")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")

    driver = webdriver.Chrome(
        service=Service(ChromeDriverManager().install()),
        options=options,
    )

    try:
        driver.get("https://platform.openai.com/docs/pricing")

        # Wait for tables to load
        WebDriverWait(driver, 15).until(
            EC.presence_of_element_located((By.TAG_NAME, "table"))
        )

        import time
        time.sleep(3)  # Extra wait for dynamic content

        page_source = driver.page_source
    finally:
        driver.quit()

    soup = BeautifulSoup(page_source, "html.parser")

    pricing = {}
    tables = soup.find_all("table")

    for table in tables:
        category = ""
        prev = table.find_previous(["h1", "h2", "h3", "h4", "h5"])
        if prev:
            category = prev.get_text(strip=True)

        headers_row = table.find("thead")
        col_headers = []
        if headers_row:
            for th in headers_row.find_all(["th", "td"]):
                col_headers.append(th.get_text(strip=True))

        tbody = table.find("tbody")
        rows = tbody.find_all("tr") if tbody else table.find_all("tr")[1:]

        for row in rows:
            cells = row.find_all(["td", "th"])
            if not cells:
                continue

            cell_texts = [cell.get_text(strip=True) for cell in cells]
            if len(cell_texts) < 2:
                continue

            model_name = cell_texts[0].lower().strip()
            price_info = {"category": category}

            for i, val in enumerate(cell_texts[1:], 1):
                if i < len(col_headers):
                    price_info[col_headers[i]] = val
                else:
                    price_info[f"col_{i}"] = val

            pricing[model_name] = price_info

    return pricing


if __name__ == "__main__":
    main()