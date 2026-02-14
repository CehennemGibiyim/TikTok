from setuptools import setup, find_packages

setup(
    name="tiktokJeton",
    version="1.0.0",
    description="TikTok otomasyonu ve hazine motoru",
    author="CehennemGibiyim",
    py_modules=["tiktokJeton"],
    install_requires=[
        "uiautomator2",
        "pytesseract",
        "requests",
        "PyQt6",
    ],
)
