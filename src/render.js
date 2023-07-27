/*
 * Copyright © 2020. TIBCO Software Inc.
 * This file is subject to the license terms contained
 * in the license file that is distributed with this file.
 */

//@ts-check
import * as d3 from "d3";
import { invalidateTooltip } from "./extended-api.js";
import { nodeFormattedPathAsArray } from "./extended-api.js";
import { addHandlersSelection } from "./ui-input.js";

/**
 * @typedef {{
 *          colorIndex: number;
 *          markedColor: string;
 *          unmarkedColor: string;
 *          markedSegments: number[][]
 *          name: string;
 *          }} RenderGroup;
 */

/**
 * Prepare some dom elements that will persist  throughout mod lifecycle
 */
const modContainer = d3.select("#mod-container");

/**
 * Main svg container
 */
const svg = modContainer.append("svg").attr("xmlns", "http://www.w3.org/2000/svg");

/**
 * Renders the chart.
 * @param {Object} state
 * @param {Spotfire.Mod} mod
 * @param {Spotfire.DataView} dataView - dataView
 * @param {Spotfire.Size} windowSize - windowSize
 */
export async function render(state, mod, dataView, windowSize) {
    if (state.preventRender) {
        // Early return if the state currently disallows rendering.
        return;
    }

    // The margins around the chart canvas.
    let margin = { top: 20, right: 40, bottom: 40, left: 80 };
    // wellbore radius in pixels
    const r = 0.025 * Math.min(windowSize.height, windowSize.width);
    // The position and size of the chart canvas.
    const canvas = { 
        top: margin.top,
        left: margin.left,
        width: windowSize.width - (margin.left + margin.right),
        height: windowSize.height - (margin.top + margin.bottom)

    };
    if (canvas.height < 0 || canvas.width < 0) {
        // Abort rendering if the window is not large enough to render anything.
        svg.selectAll("*").remove();
        return;
    }

    const onSelection = ({ dragSelectActive }) => {
        state.preventRender = dragSelectActive;
    };

    const context = mod.getRenderContext();
    const styling = context.styling;
    const { tooltip, popout } = mod.controls;
    const { radioButton, checkbox } = popout.components;
    const { section } = popout;

    invalidateTooltip(tooltip);

    /**
     * The DataView can contain errors which will cause rowCount method to throw.
     */
    let errors = await dataView.getErrors();
    if (errors.length > 0) {
        svg.selectAll("*").remove();
        mod.controls.errorOverlay.show(errors, "dataView");
        return;
    }

    mod.controls.errorOverlay.hide("dataView");

    const allrows = await dataView.allRows();
    let survey;
    try{
        survey = allrows.map(d => {
            const md = d.continuous("md").value();
            const inc  = d.continuous("inc").value();
            const az = d.continuous("az").value();
            if ((inc < 0) || (inc > 180)) {
                throw new Error(`Inclination ${inc} out of range. check survey`);
            } else if(md<0) {
                throw new Error(`MD ${md} cannot be negative. check survey`);
            } else if (az < 0 || az > 360){
                throw new Error(`Azimuth ${az} out of range. check survey`);
            }
            return {md: md, inc: inc, az: az}
        }).sort((a, b) => a.md - b.md);
    } catch (err) {
        mod.controls.errorOverlay.show(err.message, "survey");
        return;
    }
    mod.controls.errorOverlay.hide("survey");
    if (survey[0].md > 0.1) {
        survey.unshift({md:0, inc:0, az:0});
    }
    survey[0] = {...survey[0], ...{ew:0, ns:0, tvd:0, x:0}};
    for (var i = 1; i < survey.length ; i++) {
        const I1 = survey[i-1].inc * Math.PI / 180;
        const I2 = survey[i].inc * Math.PI / 180;
        const A1 = survey[i-1].az * Math.PI / 180;
        const A2 = survey[i].az * Math.PI / 180;
        const beta = Math.acos(Math.sin(I1) * Math.sin(I2) *(Math.cos(A2 - A1)-1)+Math.cos(I2-I1));
        let rf = 1;
        if (Math.abs(beta) > 0.00001) {
            rf = 2 * Math.tan(beta/2) / beta;
        }
        const dmd = survey[i].md - survey[i-1].md;
        const dz = 0.5* dmd * rf * (Math.cos(I1) + Math.cos(I2));
        const dx = 0.5* dmd * rf * (Math.sin(I1)* Math.sin(A1)+Math.sin(I2)* Math.sin(A2));
        const dy = 0.5* dmd * rf * (Math.sin(I1)* Math.cos(A1)+Math.sin(I2)* Math.cos(A2));
        const ds = Math.sqrt(dx*dx+dy*dy);
        let {ew, ns, tvd, x} = survey[i-1];
        survey[i]["ew"]  = ew + dx;
        survey[i]["ns"]  = ns + dy;
        survey[i]["tvd"] = tvd + dz;
        survey[i]["x"]   = x + ds;
    };

    const ydomain = d3.extent(survey, p => p.tvd)
    // Define the Y scale
    let yScale = d3.scaleLinear()
            .domain([ydomain[0] - 0.01*ydomain[1], 1.05 *ydomain[1]]).nice(20)
            .range([ margin.top, windowSize.height - margin.bottom]);
    

    const xdomain = d3.extent(survey, p => p.x);
    //  Define the X scale
    let xScale = d3.scaleLinear()
            .domain([xdomain[0] - 0.01*xdomain[1], 1.05* xdomain[1]]).nice(20)
            .range([margin.left, windowSize.width - margin.right]);

    const i1 = survey.length - 1;
    survey = survey.map((p,i,arr) => {
            let m, theta;
            if (i==0) {
                m = (yScale(p.tvd)-yScale(arr[i+1].tvd))/(xScale(arr[i+1].x)-xScale(p.x));
            } else if (i == i1) {
                m = (yScale(arr[i-1].tvd)-yScale(p.tvd))/(xScale(p.x)-xScale(arr[i-1].x));
            } else {
                m =  0.5 * (yScale(p.tvd)-yScale(arr[i+1].tvd))/(xScale(arr[i+1].x)-xScale(p.x));
                m += 0.5 * (yScale(arr[i-1].tvd)-yScale(p.tvd))/(xScale(p.x)-xScale(arr[i-1].x));
            }
            theta = Math.atan(-1/m);
            // console.log(`at md ${p.md}, x= ${p.x}, tvd = ${p.tvd}, m = ${m} and theta = ${theta}`)
            theta = (theta >= 0) ? theta: Math.PI + theta;
            p["theta"] = isNaN(theta) ? arr[i-1].theta : theta;
            return p; 
    });

    let curve = d3.curveCatmullRom.alpha(1);

    let line1 = d3
        .line()
        .x(d => xScale(d.x))
        .y(d => yScale(d.tvd))
        .curve(curve);

    let line2 = d3
        .line()
        .x(d => xScale(d.x) + r * Math.cos(d.theta))
        .y(d => yScale(d.tvd) - r * Math.sin(d.theta))
        .curve(curve);

    let line3 = d3
        .line()
        .x((d) => xScale(d.x) - r * Math.cos(d.theta))
        .y((d) => yScale(d.tvd) + r * Math.sin(d.theta))
        .curve(curve);

    /**
     * Sets the viewBox to match windowSize
     */
    svg.attr("viewBox", [0, 0, windowSize.width, windowSize.height]);
    svg.selectAll("*").remove();

    /**
     * Prepare groups that will hold all elements of an area chart.
     * The groups are drawn in a specific order for the best user experience:
     * - 'histogram'
     */
    svg.append("g").attr("class", "wellbore");
    /**
     * Compute the suitable ticks to show
     */
    var xAxis = svg
        .append("g")
        .attr("transform", `translate(0,${windowSize.height - margin.bottom})`)
        .call(d3.axisBottom(xScale)
            // .tickSize(styling.scales.tick.stroke != "none" ? 5 : 0)
            // .tickPadding(styling.scales.tick.stroke != "none" ? 3 : 9)
            )
        .call(g => g.append("text")
            .attr("x", d3.mean(xScale.range()))
            .attr("y", 40)
            .attr("fill", "currentColor")
            .attr("text-anchor", "start")
            .text('Distance (ft)'));

    svg.append("g")
        .attr("transform", `translate(${margin.left},0)`)
        .call(
            d3.axisLeft(yScale)
            // .tickSize(styling.scales.tick.stroke != "none" ? 5 : 0)
            // .tickPadding(styling.scales.tick.stroke != "none" ? 3 : 9)
        )
        .call(g => g.append("text")
            .attr("transform", "rotate(-90)")
            .attr("dy", -50)
            .attr("dx", -0.5 * d3.mean(xScale.range()))
            .attr("fill", "currentColor")
            .attr("text-anchor", "start")
            .text('TVD (ft)')); 

    /**
     * Style all strokes and text using current theme.
     */
    svg.selectAll("path").attr("stroke", styling.scales.line.stroke);
    svg.selectAll("line").attr("stroke", styling.scales.tick.stroke);
    svg.selectAll("text")
        .attr("fill", styling.scales.font.color)
        .attr("font-family", styling.scales.font.fontFamily)
        .attr("font-size", styling.scales.font.fontSize);


    /**
     * Create aggregated groups, sort by sum and draw each one of them.
     */
        svg.select(".wellbore")
            .append("path")
            .datum(survey)
            .attr("stroke", "black")
            .attr("stroke-width", 1)
            .attr("stroke-dasharray",4)
            .attr("fill", "none")
            .attr("d", line1)

        svg.select(".wellbore")
            .append("path")
            .datum(survey)
            .attr("stroke", "red")
            .attr("stroke-width", 2)
            .attr("fill", "none")
            .attr("d", line2);

        svg.select(".wellbore")
            .append("path")
            .datum(survey)
            .attr("stroke", "red")
            .attr("stroke-width", 2)
            .attr("fill", "none")
            .attr("d", line3);

        svg.select(".wellbore")
            .selectAll("circle")
            .data(survey)
            .enter()
            .append("circle")
            .attr("stroke", "none")
            .attr("fill", "none")
            .attr("pointer-events", "all")
            .attr("cx", d => xScale(d.x))
            .attr("cy", d => yScale(d.tvd))
            .attr("r", 5)
            .on("mouseover", pointermoved)
            .on("mouseout", () => tooltip.hide());

    function pointermoved(event, d) {
        // const i = d3.bisectCenter(survey.map(d => d.x), xScale.invert(d3.pointer(event)[0]));

        tooltip.show(` MD: ${d.md.toLocaleString('en-US', { maximumFractionDigits: 0 })} | TVD: ${d.tvd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
        // setTimeout(() =>  tooltip.hide(), 5000);
    }

}
