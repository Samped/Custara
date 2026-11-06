from setuptools import setup, find_packages

with open("README.md", encoding="utf-8") as f:
    long_description = f.read()

setup(
    name="custara_ap",
    version="1.0.0",
    description="Send ERPNext Purchase Invoices to Custara for approval and Arc USDC settlement",
    long_description=long_description,
    long_description_content_type="text/markdown",
    author="Custara",
    author_email="hello@custara.xyz",
    license="MIT",
    packages=find_packages(),
    include_package_data=True,
    zip_safe=False,
    python_requires=">=3.10",
)
