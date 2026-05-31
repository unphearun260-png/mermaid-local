#!/bin/bash

# Update GitHub Pages deployment files from source
# Usage: bash scripts/update-deploy.sh

set -e

echo "🔄 Updating GitHub Pages deployment files..."
echo ""

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Copy files
echo -e "${BLUE}Copying HTML...${NC}"
cp templates/index.html docs/
echo "✅ index.html"

echo -e "${BLUE}Copying CSS...${NC}"
cp -r static/css/* docs/css/
echo "✅ CSS files"

echo -e "${BLUE}Copying JavaScript...${NC}"
cp -r static/js/* docs/js/
echo "✅ JavaScript files"

echo -e "${BLUE}Copying Libraries...${NC}"
cp -r static/lib/* docs/lib/
echo "✅ Library files"

echo ""
echo -e "${GREEN}✨ Update complete!${NC}"
echo ""
echo "Next steps:"
echo "1. Review changes: git diff docs/"
echo "2. Commit: git add docs/ && git commit -m 'Update: [describe changes]'"
echo "3. Push: git push"
echo "4. Check deployment: GitHub Actions will deploy in 1-2 minutes"
echo ""
