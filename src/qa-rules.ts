import type { Qsr } from "./vyaguta.ts";

export type QaValidationResult = {
  valid: boolean;
  issues: string[];
};

/**
 * Validates the mathematical and logical correctness of QA defect metrics according
 * to the Leapfrog Test Metrics standard:
 *
 * 1. Total Bug Count = All bugs (Pre-release + Post-release).
 * 2. Post Production Bug Count = Only bugs found after release.
 * 3. Total Bugs Count (in BSI section) = Post-production bugs only.
 * 4. Total Bugs Count === Post Production Bug Count.
 * 5. Critical + Major + Minor === Total Bugs Count.
 * 6. DRE + DLR === 100% (or DRE=100%, DLR=0% if total bugs is 0).
 * 7. DRE = ((Total - Post) / Total) * 100.
 * 8. DLR = (Post / Total) * 100.
 * 9. BSI = (3*Critical + 2*Major + 1*Minor) / Post Production Bugs.
 * 10. Non-production projects must not report post-production bugs or >0% DLR.
 */
export function validateQaMetrics(
  entry: Qsr,
  inProduction?: boolean,
): QaValidationResult {
  const issues: string[] = [];

  const postProd = entry.postProductionBugCount;
  const totalBugs = entry.softwareDefectTotalBugCount;
  const dre = entry.defectRemovalEfficiency;
  const dlr = entry.defectLeakageRatio;
  const crit = entry.criticalCount;
  const maj = entry.majorCount;
  const min = entry.minorCount;
  const sevTotal = entry.bugSeverityTotalBugCount;
  const bsi = entry.bsi;

  const postProdNum = postProd !== null && postProd !== undefined ? Number(postProd) : null;
  const totalBugsNum = totalBugs !== null && totalBugs !== undefined ? Number(totalBugs) : null;
  const sevTotalNum = sevTotal !== null && sevTotal !== undefined ? Number(sevTotal) : null;
  const critNum = crit !== null && crit !== undefined ? Number(crit) : 0;
  const majNum = maj !== null && maj !== undefined ? Number(maj) : 0;
  const minNum = min !== null && min !== undefined ? Number(min) : 0;

  // 1. Total Bugs Count (BSI section) must equal Post Production Bug Count
  if (postProdNum !== null && sevTotalNum !== null) {
    if (postProdNum !== sevTotalNum) {
      issues.push(
        `Post Production Bug Count (${postProdNum}) does not match Total Bugs Count in severity section (${sevTotalNum})`,
      );
    }
  }

  // 2. Severity sum reconciliation: Critical + Major + Minor === Total Bugs Count
  if (sevTotalNum !== null) {
    const sevSum = critNum + majNum + minNum;
    if (sevSum !== sevTotalNum) {
      issues.push(
        `Severity breakdown (${critNum} Critical + ${majNum} Major + ${minNum} Minor = ${sevSum}) does not equal Total Bugs Count (${sevTotalNum})`,
      );
    }
  } else if (critNum + majNum + minNum > 0) {
    // Non-zero severities were entered but sevTotal was left empty
    issues.push("Severity breakdown has bugs reported but Total Bugs Count is missing");
  }

  // 3. Total Bug Count (all bugs) cannot be less than Post Production Bug Count
  if (totalBugsNum !== null && postProdNum !== null) {
    if (totalBugsNum < postProdNum) {
      issues.push(
        `Total Bug Count (${totalBugsNum}) cannot be less than Post Production Bug Count (${postProdNum})`,
      );
    }
  }

  // 4. DRE + DLR Golden Identity: must add up to 100%
  if (dre !== null && dre !== undefined && dlr !== null && dlr !== undefined) {
    const dreNum = Number(dre);
    const dlrNum = Number(dlr);
    const sum = dreNum + dlrNum;

    if (totalBugsNum === 0) {
      if (dreNum === 0 && dlrNum === 0) {
        issues.push("Total Bug Count is 0: DRE should be 100% and DLR 0% (both were entered as 0%)");
      }
    } else if (Math.abs(sum - 100) > 0.5) {
      issues.push(
        `DRE (${dreNum}%) and DLR (${dlrNum}%) must add up to 100% (currently ${sum.toFixed(1)}%)`,
      );
    }
  }

  // 5. DLR Formula check: (Post / Total) * 100
  if (totalBugsNum !== null && totalBugsNum > 0 && postProdNum !== null) {
    const expectedDlr = (postProdNum / totalBugsNum) * 100;
    if (dlr !== null && dlr !== undefined) {
      const dlrNum = Number(dlr);
      if (Math.abs(dlrNum - expectedDlr) > 0.5) {
        issues.push(
          `DLR is entered as ${dlrNum}%, but calculated is ${expectedDlr.toFixed(1)}% (${postProdNum}/${totalBugsNum} bugs)`,
        );
      }
    }
  }

  // 6. DRE Formula check: ((Total - Post) / Total) * 100
  if (totalBugsNum !== null && totalBugsNum > 0 && postProdNum !== null) {
    const preProd = totalBugsNum - postProdNum;
    const expectedDre = (preProd / totalBugsNum) * 100;
    if (dre !== null && dre !== undefined) {
      const dreNum = Number(dre);
      if (Math.abs(dreNum - expectedDre) > 0.5) {
        issues.push(
          `DRE is entered as ${dreNum}%, but calculated is ${expectedDre.toFixed(1)}% (${preProd}/${totalBugsNum} bugs)`,
        );
      }
    }
  }

  // 7. BSI Formula check: (3*Critical + 2*Major + 1*Minor) / Post-Production Bugs
  const postBugsCount = sevTotalNum ?? postProdNum ?? 0;
  if (postBugsCount > 0) {
    const expectedBsi = (3 * critNum + 2 * majNum + 1 * minNum) / postBugsCount;
    if (bsi !== null && bsi !== undefined) {
      const bsiNum = Number(bsi);
      if (Math.abs(bsiNum - expectedBsi) > 0.05) {
        issues.push(
          `BSI is entered as ${bsiNum}, but calculated is ${expectedBsi.toFixed(2)}`,
        );
      }
    } else {
      issues.push(`BSI is missing (calculated is ${expectedBsi.toFixed(2)})`);
    }
  } else if (bsi !== null && bsi !== undefined && Number(bsi) !== 0) {
    issues.push(`BSI is entered as ${bsi}, but should be 0 when post-production bugs is 0`);
  }

  // 8. Production status constraints
  if (inProduction === false) {
    if (postProdNum !== null && postProdNum > 0) {
      issues.push(
        `Project is marked as NOT in production, but reports ${postProdNum} post-production bug(s)`,
      );
    }
    if (dlr !== null && dlr !== undefined && Number(dlr) > 0) {
      issues.push(
        `Project is marked as NOT in production, but reports DLR of ${dlr}% (expected 0%)`,
      );
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}
