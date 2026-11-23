import requests

API_KEY = "06f17300333a4c7c8e2c74851cf9a572"

url = "https://www.binance.bh/bapi/composite/v1/public/pgc/openApi/content/add"


headers = {
    "X-Square-OpenAPI-Key": API_KEY,
    "Content-Type": "application/json",
    "clienttype": "binanceSkill"
}

data = {
    "bodyTextOnly": "Hello Binance Square! $BTC #Crypto"
}

resp = requests.post(url, headers=headers, json=data, timeout=10)
print(resp.status_code)
print(resp.json())