import { useState, useEffect } from 'react';
import { useProjectConfig } from '../hooks/useProjectConfig';
import styles from './ProjectConfigSection.module.css';

/**
 * Project Configuration section component
 * Manages S1000D/DITA project metadata and settings
 * @returns {JSX.Element} Project configuration form
 */
export default function ProjectConfigSection() {
  const { projectConfig, saveProjectConfig } = useProjectConfig();
  const [formData, setFormData] = useState(projectConfig);
  const [errors, setErrors] = useState({});
  const [showSaved, setShowSaved] = useState(false);

  // Update form when projectConfig changes
  useEffect(() => {
    setFormData(projectConfig);
  }, [projectConfig]);

  /**
   * Validate form fields
   * @returns {Object} Errors object with field names as keys
   */
  const validateForm = () => {
    const newErrors = {};

    if (!formData.projectName.trim()) {
      newErrors.projectName = 'Project Name is required';
    }
    if (!formData.modelIdentCode.trim()) {
      newErrors.modelIdentCode = 'Model Ident Code is required';
    }
    if (!formData.systemDiffCode.trim()) {
      newErrors.systemDiffCode = 'System Diff Code is required';
    }
    if (!formData.issueNumber.trim()) {
      newErrors.issueNumber = 'Issue Number is required';
    }
    if (!formData.inWork.trim()) {
      newErrors.inWork = 'In Work is required';
    }
    if (!formData.languageIsoCode.trim()) {
      newErrors.languageIsoCode = 'Language ISO Code is required';
    }
    if (!formData.countryIsoCode.trim()) {
      newErrors.countryIsoCode = 'Country ISO Code is required';
    }
    if (!formData.securityClassification.trim()) {
      newErrors.securityClassification = 'Security Classification is required';
    }
    if (!formData.enterpriseCode.trim()) {
      newErrors.enterpriseCode = 'Enterprise Code is required';
    }

    return newErrors;
  };

  /**
   * Handle input change
   */
  const handleInputChange = (field, value) => {
    setFormData(prev => ({
      ...prev,
      [field]: value
    }));
    // Clear error for this field when user starts typing
    if (errors[field]) {
      setErrors(prev => ({
        ...prev,
        [field]: ''
      }));
    }
  };

  /**
   * Handle save button click
   */
  const handleSave = () => {
    const newErrors = validateForm();

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    saveProjectConfig(formData);
    setShowSaved(true);
    setTimeout(() => setShowSaved(false), 2000);
  };

  return (
    <div className={styles.section}>
      <h3 className={styles.heading}>Project Configuration</h3>

      <div className={styles.formGrid}>
        {/* Project Name */}
        <div className={styles.formGroup}>
          <label htmlFor="projectName" className={styles.label}>
            Project Name
          </label>
          <input
            id="projectName"
            type="text"
            value={formData.projectName}
            onChange={(e) => handleInputChange('projectName', e.target.value)}
            placeholder="My S1000D Project"
            className={styles.input}
          />
          {errors.projectName && (
            <p className={styles.error}>{errors.projectName}</p>
          )}
        </div>

        {/* Model Ident Code */}
        <div className={styles.formGroup}>
          <label htmlFor="modelIdentCode" className={styles.label}>
            Model Ident Code
          </label>
          <input
            id="modelIdentCode"
            type="text"
            value={formData.modelIdentCode}
            onChange={(e) => handleInputChange('modelIdentCode', e.target.value)}
            placeholder="CAGE12345"
            className={styles.input}
          />
          {errors.modelIdentCode && (
            <p className={styles.error}>{errors.modelIdentCode}</p>
          )}
        </div>

        {/* System Diff Code */}
        <div className={styles.formGroup}>
          <label htmlFor="systemDiffCode" className={styles.label}>
            System Diff Code
          </label>
          <input
            id="systemDiffCode"
            type="text"
            value={formData.systemDiffCode}
            onChange={(e) => handleInputChange('systemDiffCode', e.target.value)}
            className={styles.input}
          />
          {errors.systemDiffCode && (
            <p className={styles.error}>{errors.systemDiffCode}</p>
          )}
        </div>

        {/* Issue Number */}
        <div className={styles.formGroup}>
          <label htmlFor="issueNumber" className={styles.label}>
            Issue Number
          </label>
          <input
            id="issueNumber"
            type="text"
            value={formData.issueNumber}
            onChange={(e) => handleInputChange('issueNumber', e.target.value)}
            className={styles.input}
          />
          {errors.issueNumber && (
            <p className={styles.error}>{errors.issueNumber}</p>
          )}
        </div>

        {/* In Work */}
        <div className={styles.formGroup}>
          <label htmlFor="inWork" className={styles.label}>
            In Work
          </label>
          <input
            id="inWork"
            type="text"
            value={formData.inWork}
            onChange={(e) => handleInputChange('inWork', e.target.value)}
            className={styles.input}
          />
          {errors.inWork && (
            <p className={styles.error}>{errors.inWork}</p>
          )}
        </div>

        {/* Language ISO Code */}
        <div className={styles.formGroup}>
          <label htmlFor="languageIsoCode" className={styles.label}>
            Language ISO Code
          </label>
          <input
            id="languageIsoCode"
            type="text"
            value={formData.languageIsoCode}
            onChange={(e) => handleInputChange('languageIsoCode', e.target.value)}
            className={styles.input}
          />
          {errors.languageIsoCode && (
            <p className={styles.error}>{errors.languageIsoCode}</p>
          )}
        </div>

        {/* Country ISO Code */}
        <div className={styles.formGroup}>
          <label htmlFor="countryIsoCode" className={styles.label}>
            Country ISO Code
          </label>
          <input
            id="countryIsoCode"
            type="text"
            value={formData.countryIsoCode}
            onChange={(e) => handleInputChange('countryIsoCode', e.target.value)}
            className={styles.input}
          />
          {errors.countryIsoCode && (
            <p className={styles.error}>{errors.countryIsoCode}</p>
          )}
        </div>

        {/* Security Classification */}
        <div className={styles.formGroup}>
          <label htmlFor="securityClassification" className={styles.label}>
            Security Classification
          </label>
          <select
            id="securityClassification"
            value={formData.securityClassification}
            onChange={(e) => handleInputChange('securityClassification', e.target.value)}
            className={styles.select}
          >
            {Array.from({ length: 10 }, (_, i) => {
              const value = String(i + 1).padStart(2, '0');
              return (
                <option key={value} value={value}>
                  {value}
                </option>
              );
            })}
          </select>
          {errors.securityClassification && (
            <p className={styles.error}>{errors.securityClassification}</p>
          )}
        </div>

        {/* Enterprise Code */}
        <div className={styles.formGroup}>
          <label htmlFor="enterpriseCode" className={styles.label}>
            Enterprise Code
          </label>
          <input
            id="enterpriseCode"
            type="text"
            value={formData.enterpriseCode}
            onChange={(e) => handleInputChange('enterpriseCode', e.target.value)}
            placeholder="CAGE12345"
            className={styles.input}
          />
          {errors.enterpriseCode && (
            <p className={styles.error}>{errors.enterpriseCode}</p>
          )}
        </div>

        {/* Primary Format */}
        <div className={styles.formGroup}>
          <label htmlFor="primaryFormat" className={styles.label}>
            Primary Format
          </label>
          <select
            id="primaryFormat"
            value={formData.primaryFormat || ''}
            onChange={(e) => handleInputChange('primaryFormat', e.target.value)}
            className={styles.select}
          >
            <option value="">— No format selected —</option>
            <option value="BREX-3.0.1">BREX — S1000D 3.0.1</option>
            <option value="BREX-4.1">BREX — S1000D 4.1</option>
            <option value="BREX-4.2">BREX — S1000D 4.2</option>
            <option value="SCH-S1000D">Schematron 1.0 — S1000D</option>
            <option value="SCH-DITA">Schematron 1.0 — DITA</option>
          </select>
        </div>
      </div>

      {/* Save Button and Confirmation */}
      <div className={styles.footer}>
        <button onClick={handleSave} className={styles.saveBtn}>
          Save Configuration
        </button>
        {showSaved && (
          <p className={styles.savedMessage}>Configuration saved successfully</p>
        )}
      </div>
    </div>
  );
}
