import os
import re
import json
import base64
from typing import TypedDict, Optional
from google import genai
from google.genai import types

class DetectionResult(TypedDict):
    plate: str
    vehicle: str
    confidence: float
    isValid: bool
    raw: Optional[str]

def get_ai_client():
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise ValueError("GEMINI_API_KEY is not set in the environment variables.")
    return genai.Client(api_key=api_key)

async def detect_vehicle_and_plate(base64_image: str) -> DetectionResult:
    try:
        client = get_ai_client()
        
        response = client.models.generate_content(
            model="gemini-2.0-flash",
            contents=[
                types.Part.from_bytes(
                    data=base64.b64decode(base64_image),
                    mime_type="image/jpeg"
                ),
                types.Part.from_text(text="""Analyze this vehicle entry image for a college gate system.
                1. Extract the vehicle license plate number (OCR).
                2. Identify the vehicle type (car, bus, truck, bike).
                3. Provide a confidence score (0.0 to 1.0) for the OCR.
                
                Rules:
                - Focus on Indian license plate formats (e.g., TS09EA1234, KA01AB1234).
                - If multiple vehicles, focus on the most prominent one.
                - Return ONLY a JSON object. No markdown formatting.""")
            ],
            config=types.GenerateContentConfig(
                response_mime_type="application/json"
            )
        )

        if not response.text:
            raise ValueError("Gemini returned an empty response")

        try:
            # Clean potential markdown or extra text
            json_match = re.search(r'\{[\s\S]*\}', response.text)
            json_str = json_match.group(0) if json_match else response.text
            result = json.loads(json_str)
        except Exception as e:
            print(f"Failed to parse Gemini JSON: {response.text}")
            raise ValueError("Invalid JSON response from Gemini")

        # Clean and validate plate
        plate_val = result.get("plate", "")
        clean_plate = re.sub(r'[^A-Z0-9]', "", plate_val).upper()
        indian_plate_regex = r'^[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{4}$'
        is_valid = bool(re.match(indian_plate_regex, clean_plate))

        return {
            "plate": clean_plate,
            "vehicle": result.get("vehicle", "unknown"),
            "confidence": result.get("confidence", 0.0),
            "isValid": is_valid,
            "raw": response.text
        }
    except Exception as error:
        print(f"OCR Pipeline Error: {error}")
        raise error
