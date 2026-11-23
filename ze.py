import requests
import json

# 1. Replace with the actual token provided to you
API_TOKEN = "020ed6a1ba2fe3aa85026b90d7f946ef81cebdb8f917aa0b" 

# 2. The endpoint you provided
url = "https://api.amadd.cc.cd/v1/chat/completions"

# 3. Set up the headers (Authentication goes here)
headers = {
    "Authorization": f"Bearer {API_TOKEN}",
    "Content-Type": "application/json"
}

# 4. Set up the payload. 
# NOTE: You must know which model names this proxy supports (e.g., "gpt-3.5-turbo", "gpt-4", "claude-3-haiku").
# I am using "gpt-3.5-turbo" as a placeholder. Change it if needed.
data = {
    "model": "glm-5.3", 
    "messages": [
        {"role": "user", "content": "Hello! Are you working?"}
    ],
    "temperature": 0.7
}

try:
    # 5. Send the POST request
    response = requests.post(url, headers=headers, json=data, timeout=30)
    
    # 6. Check the response
    if response.status_code == 200:
        print("✅ Success!")
        # Extract and print the AI's reply
        result = response.json()
        print(result['choices'][0]['message']['content'])
    else:
        print(f"❌ Failed with status code: {response.status_code}")
        print("Error details:", response.text)
        
except Exception as e:
    print(f"⚠️ Request error: {e}")