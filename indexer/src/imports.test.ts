import { describe, expect, it } from "vitest";
import { extractImports } from "./imports";

describe("extractImports — TypeScript/JavaScript", () => {
  it("resolves relative imports to repo files and records bare specifiers as packages", () => {
    const repo = new Set(["src/api/client.ts", "src/util/index.ts", "src/app.ts"]);
    const src = [
      "import { get } from './api/client';",
      "import * as util from './util';",
      "import React from 'react';",
      "import { z } from 'zod/v4';",
    ].join("\n");

    expect(extractImports("src/app.ts", src, "typescript", repo)).toEqual({
      imports: ["src/api/client.ts", "src/util/index.ts"],
      packages: ["react", "zod"],
    });
  });

  it("resolves ESM-style '.js' specifiers to the TypeScript source", () => {
    const repo = new Set(["src/client.ts", "src/main.ts"]);

    expect(extractImports("src/main.ts", "export { a } from './client.js';", "typescript", repo).imports).toEqual([
      "src/client.ts",
    ]);
  });
});

describe("extractImports — Python", () => {
  const repo = new Set([
    "backend/app/main.py",
    "backend/app/models.py",
    "backend/app/core/__init__.py",
    "backend/app/core/db.py",
    "backend/app/services/sim.py",
  ]);

  it("resolves relative and project-absolute imports, and records third-party packages", () => {
    const src = [
      "import os",
      "import numpy as np",
      "from fastapi import FastAPI",
      "from .models import User",
      "from .core import db",
      "from app.services.sim import run",
      "from . import models",
    ].join("\n");

    expect(extractImports("backend/app/main.py", src, "python", repo)).toEqual({
      imports: ["backend/app/models.py", "backend/app/core/db.py", "backend/app/services/sim.py"],
      packages: ["os", "numpy", "fastapi"],
    });
  });
});
